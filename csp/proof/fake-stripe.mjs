#!/usr/bin/env node
// A fake Stripe for the checkout proof: just enough of the Stripe REST API for
// a pinned Ghost to set up a paid tier, open a checkout session and learn that
// it was paid, plus a hosted "checkout" page on its own origin and a signed
// webhook sender. node:http and node:crypto only, so it needs no install.
//
// What it proves and what it does not. Ghost talks to this server because
// STRIPE_API_HOST/PORT/PROTOCOL point its Stripe client here, so the proof
// exercises Ghost's own pages under the content policy with no Stripe account
// and no network. It does NOT prove anything about Stripe's own pages on
// checkout.stripe.com or Stripe's real webhooks; those need a real TEST-mode
// account (see csp/README.md).
//
// Safety: it refuses any key that is not sk_test_, and the only card the hosted
// page accepts is Stripe's published test card 4242 4242 4242 4242; the
// published decline card 4000 0000 0000 0002 is refused. No real card number
// is ever meaningful here.
import crypto from 'node:crypto';
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEST_CARD_OK = '4242424242424242';
export const TEST_CARD_DECLINED = '4000000000000002';

/** Parses Stripe's bracketed form encoding (`a[b][0]=c`) into nested objects. */
export function parseForm(body) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const path = rawKey.split(/\[|\]/).filter((part) => part !== '');
    let node = out;
    path.forEach((part, i) => {
      if (i === path.length - 1) {
        node[part] = value;
      } else {
        node[part] ??= /^\d+$/.test(path[i + 1]) ? [] : {};
        node = node[part];
      }
    });
  }
  return out;
}

/** The `Stripe-Signature` header value for a payload: t=<ts>,v1=HMAC-SHA256(secret, `${t}.${payload}`). */
export function signStripeEvent(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

function stripeError(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'invalid_request_error', code, message } }));
}

const json = (res, value) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

const list = (data) => ({ object: 'list', data, has_more: false, url: '/v1/list' });

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

function checkoutPage(session, message = '') {
  // The hosted page is a different origin from the tenant, so the tenant's
  // content policy does not govern it; it is plain HTML with no script.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake Stripe Checkout</title></head>
<body>
<h1 id="fake-checkout">Fake Stripe Checkout (test mode)</h1>
<p>This page stands in for the hosted checkout page. Test cards only.</p>
${message ? `<p id="checkout-error" role="alert">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/c/pay/${escapeHtml(session.id)}/confirm">
  <label>Email <input name="email" type="email" value="${escapeHtml(session.customer_email || '')}" readonly></label><br>
  <label>Card number <input name="cardnumber" id="cardnumber" inputmode="numeric" autocomplete="off"></label><br>
  <label>Expiry <input name="exp" id="exp" value="12 / 34"></label>
  <label>CVC <input name="cvc" id="cvc" value="123"></label><br>
  <button type="submit" id="pay">Subscribe</button>
</form>
</body></html>`;
}

/**
 * Starts the fake. Options:
 *   port             listen port (0 picks one)
 *   publicUrl        the browser-reachable origin of this server, used to build
 *                    `session.url`; defaults to http://localhost:<port>
 *   webhookUrl       where `checkout.session.completed` is POSTed on payment
 *   webhookSecret    the whsec_ string the target verifies signatures with
 */
export async function startFakeStripe({
  port = 0,
  host = '0.0.0.0',
  publicUrl = null,
  webhookUrl = null,
  webhookSecret = null,
} = {}) {
  const state = {
    products: new Map(),
    prices: new Map(),
    customers: new Map(),
    subscriptions: new Map(),
    sessions: new Map(),
    requests: [],
    unhandled: [],
    webhooks: [],
  };
  let origin = publicUrl;

  const priceObject = (p) => ({ ...p });
  const subscriptionObject = (sub) => ({
    ...sub,
    items: {
      object: 'list',
      data: sub.items.data.map((i) => ({ ...i, price: priceObject(i.price) })),
      has_more: false,
    },
  });
  const customerObject = (customer, expand) => {
    const subs = [...state.subscriptions.values()].filter((s) => s.customer === customer.id);
    return {
      ...customer,
      subscriptions: list(
        subs.map((s) => ({
          ...subscriptionObject(s),
          default_payment_method: expand.includes('subscriptions.data.default_payment_method')
            ? paymentMethod(s.default_payment_method)
            : s.default_payment_method,
        }))
      ),
    };
  };
  const paymentMethod = (pmId) => ({
    id: pmId,
    object: 'payment_method',
    type: 'card',
    billing_details: { name: 'Test Member', email: null },
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2034, country: 'US' },
  });

  async function deliverWebhook(event) {
    const payload = JSON.stringify(event);
    const record = { type: event.type, status: null, error: null };
    state.webhooks.push(record);
    if (!webhookUrl || !webhookSecret) {
      record.error = 'no webhook target configured';
      return record;
    }
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': signStripeEvent(payload, webhookSecret),
        },
        body: payload,
      });
      record.status = res.status;
    } catch (err) {
      record.error = String(err.message || err);
    }
    return record;
  }

  async function confirmPayment(session, form) {
    if (form.cardnumber.replace(/\s+/g, '') !== TEST_CARD_OK) {
      return { ok: false, message: 'Your card was declined.' };
    }
    let customer = session.customer && state.customers.get(session.customer);
    if (!customer) {
      customer = {
        id: id('cus'),
        object: 'customer',
        email: session.customer_email,
        name: null,
        created: now(),
        metadata: {},
      };
      state.customers.set(customer.id, customer);
    }
    const priceId = session.subscription_data?.items?.[0]?.plan;
    const price = state.prices.get(priceId);
    if (!price) return { ok: false, message: `unknown price ${priceId}` };
    const sub = {
      id: id('sub'),
      object: 'subscription',
      status: 'active',
      customer: customer.id,
      default_payment_method: id('pm'),
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      created: now(),
      start_date: now(),
      current_period_start: now(),
      current_period_end: now() + 30 * 86400,
      trial_start: null,
      trial_end: null,
      discount: null,
      latest_invoice: null,
      metadata: session.subscription_data?.metadata || {},
      items: {
        object: 'list',
        data: [{ id: id('si'), object: 'subscription_item', price }],
        has_more: false,
      },
      plan: price,
    };
    state.subscriptions.set(sub.id, sub);
    session.status = 'complete';
    session.payment_status = 'paid';
    session.customer = customer.id;
    session.subscription = sub.id;
    const event = {
      id: id('evt'),
      object: 'event',
      api_version: '2020-08-27',
      created: now(),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: session.id,
          object: 'checkout.session',
          mode: 'subscription',
          status: 'complete',
          payment_status: 'paid',
          customer: customer.id,
          customer_email: customer.email,
          subscription: sub.id,
          metadata: session.metadata || {},
          success_url: session.success_url,
        },
      },
    };
    await deliverWebhook(event);
    return { ok: true };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-stripe');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf-8');
    state.requests.push({ method: req.method, path: url.pathname });

    try {
      // Operator view, not part of the Stripe API.
      if (url.pathname === '/__state') {
        return json(res, {
          requests: state.requests,
          unhandled: state.unhandled,
          webhooks: state.webhooks,
          sessions: [...state.sessions.values()],
          customers: [...state.customers.values()],
          subscriptions: [...state.subscriptions.values()],
        });
      }

      // The hosted checkout page, on this server's own origin.
      const pay = url.pathname.match(/^\/c\/pay\/([^/]+)(\/confirm)?$/);
      if (pay) {
        const session = state.sessions.get(pay[1]);
        if (!session) return stripeError(res, 404, 'resource_missing', 'no such session');
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(checkoutPage(session));
        }
        const result = await confirmPayment(session, parseForm(raw));
        if (!result.ok) {
          res.writeHead(402, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(checkoutPage(session, result.message));
        }
        res.writeHead(303, { Location: session.success_url });
        return res.end();
      }

      // From here, the Stripe API proper: test keys only.
      const auth = req.headers.authorization || '';
      if (!/^Bearer sk_test_/.test(auth)) {
        return stripeError(
          res,
          401,
          'api_key_invalid',
          'only sk_test_ keys are accepted by this fake'
        );
      }
      const form = raw ? parseForm(raw) : {};
      const query = Object.fromEntries(url.searchParams);
      const expand = [
        ...url.searchParams.getAll('expand[]'),
        ...Object.values(parseForm(url.search.slice(1)).expand || {}),
      ];
      const route = `${req.method} ${url.pathname.replace(/\/(prod|price|cus|sub|pm|cs)_[A-Za-z0-9]+/, '/:id')}`;

      switch (route) {
        case 'POST /v1/products': {
          const product = {
            id: id('prod'),
            object: 'product',
            active: true,
            created: now(),
            metadata: {},
            ...form,
          };
          state.products.set(product.id, product);
          return json(res, product);
        }
        case 'GET /v1/products/:id':
        case 'POST /v1/products/:id': {
          const product = state.products.get(url.pathname.split('/').pop());
          if (!product) return stripeError(res, 404, 'resource_missing', 'No such product');
          if (req.method === 'POST') Object.assign(product, form);
          return json(res, product);
        }
        case 'POST /v1/prices': {
          const price = {
            id: id('price'),
            object: 'price',
            active: true,
            created: now(),
            type: 'recurring',
            livemode: false,
            ...form,
            unit_amount: Number(form.unit_amount),
          };
          state.prices.set(price.id, price);
          return json(res, price);
        }
        case 'GET /v1/prices/:id':
        case 'POST /v1/prices/:id': {
          const price = state.prices.get(url.pathname.split('/').pop());
          if (!price) return stripeError(res, 404, 'resource_missing', 'No such price');
          if (req.method === 'POST') Object.assign(price, form);
          return json(res, price);
        }
        case 'POST /v1/customers': {
          const customer = {
            id: id('cus'),
            object: 'customer',
            created: now(),
            metadata: {},
            name: null,
            ...form,
          };
          state.customers.set(customer.id, customer);
          return json(res, customerObject(customer, expand));
        }
        case 'GET /v1/customers/search': {
          const email = (query.query || '').match(/email:'([^']*)'/)?.[1];
          const found = [...state.customers.values()].filter((c) => !email || c.email === email);
          return json(res, list(found));
        }
        case 'GET /v1/customers/:id':
        case 'POST /v1/customers/:id': {
          const customer = state.customers.get(url.pathname.split('/').pop());
          if (!customer) return stripeError(res, 404, 'resource_missing', 'No such customer');
          if (req.method === 'POST') Object.assign(customer, form);
          return json(res, customerObject(customer, expand));
        }
        case 'GET /v1/subscriptions/:id': {
          const sub = state.subscriptions.get(url.pathname.split('/').pop());
          if (!sub) return stripeError(res, 404, 'resource_missing', 'No such subscription');
          return json(res, subscriptionObject(sub));
        }
        case 'GET /v1/payment_methods/:id':
          return json(res, paymentMethod(url.pathname.split('/').pop()));
        case 'POST /v1/billing_portal/configurations':
          return json(res, { id: id('bpc'), object: 'billing_portal.configuration' });
        case 'POST /v1/checkout/sessions': {
          if (!origin) origin = `http://localhost:${server.address().port}`;
          const session = {
            id: id('cs_test'),
            object: 'checkout.session',
            status: 'open',
            ...form,
          };
          session.url = `${origin}/c/pay/${session.id}`;
          state.sessions.set(session.id, session);
          return json(res, session);
        }
        default:
          state.unhandled.push(route);
          return stripeError(
            res,
            404,
            'resource_missing',
            `fake-stripe does not implement ${route}`
          );
      }
    } catch (err) {
      // The detail stays on the fake's own stderr; the response carries none.
      console.error(`fake-stripe: ${req.method} ${url.pathname} failed: ${err?.message ?? err}`);
      return stripeError(res, 500, 'fake_error', 'the fake hit an internal error');
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const boundPort = server.address().port;
  if (!origin) origin = `http://localhost:${boundPort}`;

  return {
    port: boundPort,
    origin,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const fake = await startFakeStripe({
    port: Number(process.env.FAKE_STRIPE_PORT || 12111),
    publicUrl: process.env.FAKE_STRIPE_PUBLIC_URL || null,
    webhookUrl: process.env.FAKE_STRIPE_WEBHOOK_URL || null,
    webhookSecret: process.env.FAKE_STRIPE_WEBHOOK_SECRET || null,
  });
  console.log(`fake-stripe: port=${fake.port} origin=${fake.origin}`);
}
