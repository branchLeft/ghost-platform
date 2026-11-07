// node --test csp/proof/fake-stripe.test.mjs -- node:test, node:http and
// node:crypto only. The fake stands in for Stripe in the checkout proof, so
// what matters here is the part that could let the proof pass for the wrong
// reason: it must refuse non-test keys and non-test cards, and its webhook
// signature must be the real Stripe scheme (so Ghost's own verification, not a
// bypass, accepts it).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import {
  parseForm,
  signStripeEvent,
  startFakeStripe,
  TEST_CARD_DECLINED,
  TEST_CARD_OK,
} from './fake-stripe.mjs';

const SECRET = 'whsec_testonly_not_a_real_secret';
const KEY = { Authorization: 'Bearer sk_test_synthetic' };

async function receiver() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') });
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    received,
    url: `http://127.0.0.1:${server.address().port}/members/webhooks/stripe/`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const post = (base, path, form, headers = KEY) =>
  fetch(base + path, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

async function setupPrice(base) {
  const product = await (await post(base, '/v1/products', { name: 'Default Product' })).json();
  return (
    await (
      await post(base, '/v1/prices', {
        currency: 'usd',
        product: product.id,
        unit_amount: '500',
        'recurring[interval]': 'month',
      })
    ).json()
  ).id;
}

test('parseForm nests bracketed keys and indexes into arrays', () => {
  assert.deepEqual(parseForm('a[b][0][c]=1&a[b][1][c]=2&x=y'), {
    a: { b: [{ c: '1' }, { c: '2' }] },
    x: 'y',
  });
});

test('signStripeEvent is the real t=,v1=HMAC-SHA256(t.payload) scheme', () => {
  const header = signStripeEvent('{"a":1}', SECRET, 1700000000);
  const expected = crypto.createHmac('sha256', SECRET).update('1700000000.{"a":1}').digest('hex');
  assert.equal(header, `t=1700000000,v1=${expected}`);
});

test('control: a non-test key is refused, a test key is accepted', async () => {
  const fake = await startFakeStripe({ host: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${fake.port}`;
    const live = await post(
      base,
      '/v1/products',
      { name: 'x' },
      { Authorization: `Bearer ${['sk', 'live', 'abc'].join('_')}` }
    );
    assert.equal(live.status, 401);
    const none = await post(base, '/v1/products', { name: 'x' }, {});
    assert.equal(none.status, 401);
    const ok = await post(base, '/v1/products', { name: 'x' });
    assert.equal(ok.status, 200);
  } finally {
    await fake.close();
  }
});

test('a paid checkout creates a subscription and sends a correctly signed webhook', async () => {
  const sink = await receiver();
  const fake = await startFakeStripe({
    host: '127.0.0.1',
    publicUrl: 'http://localhost:9999',
    webhookUrl: sink.url,
    webhookSecret: SECRET,
  });
  try {
    const base = `http://127.0.0.1:${fake.port}`;
    const priceId = await setupPrice(base);
    const session = await (
      await post(base, '/v1/checkout/sessions', {
        customer_email: 'member@example.test',
        success_url: 'http://localhost:4311/?stripe=success',
        'subscription_data[items][0][plan]': priceId,
      })
    ).json();
    assert.match(session.url, /^http:\/\/localhost:9999\/c\/pay\/cs_test_/);

    const page = await fetch(`${base}/c/pay/${session.id}`);
    assert.match(await page.text(), /Fake Stripe Checkout/);

    const confirm = await fetch(`${base}/c/pay/${session.id}/confirm`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `cardnumber=${TEST_CARD_OK}`,
    });
    assert.equal(confirm.status, 303);
    assert.equal(confirm.headers.get('location'), 'http://localhost:4311/?stripe=success');

    assert.equal(sink.received.length, 1);
    const { headers, body } = sink.received[0];
    const [t, v1] = headers['stripe-signature'].split(',').map((p) => p.split('=')[1]);
    const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
    assert.equal(v1, expected);
    assert.equal(JSON.parse(body).type, 'checkout.session.completed');

    // The customer Ghost reads back carries the subscription and its price.
    const customerId = JSON.parse(body).data.object.customer;
    const customer = await (
      await fetch(
        `${base}/v1/customers/${customerId}?expand[0]=subscriptions.data.default_payment_method`,
        {
          headers: KEY,
        }
      )
    ).json();
    assert.equal(customer.subscriptions.data[0].items.data[0].price.id, priceId);
    assert.equal(customer.subscriptions.data[0].default_payment_method.card.last4, '4242');
  } finally {
    await fake.close();
    await sink.close();
  }
});

test('control: the published decline card is refused and sends no webhook', async () => {
  const sink = await receiver();
  const fake = await startFakeStripe({
    host: '127.0.0.1',
    webhookUrl: sink.url,
    webhookSecret: SECRET,
  });
  try {
    const base = `http://127.0.0.1:${fake.port}`;
    const priceId = await setupPrice(base);
    const session = await (
      await post(base, '/v1/checkout/sessions', {
        customer_email: 'member@example.test',
        success_url: 'http://localhost:4311/?stripe=success',
        'subscription_data[items][0][plan]': priceId,
      })
    ).json();
    const declined = await fetch(`${base}/c/pay/${session.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `cardnumber=${TEST_CARD_DECLINED}`,
    });
    assert.equal(declined.status, 402);
    assert.equal(sink.received.length, 0);

    // Any number other than the published success card is refused too.
    const real = await fetch(`${base}/c/pay/${session.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'cardnumber=4111111111111111',
    });
    assert.equal(real.status, 402);
    assert.equal(sink.received.length, 0);
  } finally {
    await fake.close();
    await sink.close();
  }
});

test('an endpoint it does not implement is recorded, never silently answered', async () => {
  const fake = await startFakeStripe({ host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${fake.port}/v1/refunds`, { headers: KEY });
    assert.equal(res.status, 404);
    assert.deepEqual(fake.state.unhandled, ['GET /v1/refunds']);
  } finally {
    await fake.close();
  }
});
