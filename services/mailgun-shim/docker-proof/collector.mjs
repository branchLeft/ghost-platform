// The test/helpers/collector.ts drain loop, re-expressed with zero npm
// dependencies (Node's built-in fetch only) so this container needs no
// `npm install` and no route out to a registry -- it only ever talks to
// SHIM_BASE_URL (over the shared internal Docker network) and
// DELIVERY_BASE_URL (over the separate delivery network). This is the
// stand-in for mx1/ops1: the only thing on the other end of GET /drain.
const shimBaseUrl = requireEnv('SHIM_BASE_URL');
const drainToken = requireEnv('SHIM_DRAIN_TOKEN');
const deliveryBaseUrl = requireEnv('DELIVERY_BASE_URL');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

async function drainOnce({ ack = true } = {}) {
  const res = await fetch(`${shimBaseUrl}/drain`, {
    headers: { Authorization: `Bearer ${drainToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET /drain -> ${res.status}`);
  }
  const body = await res.json();
  if (body.messages.length === 0) {
    return { delivered: [], acked: [] };
  }

  const delivered = [];
  const acks = [];
  for (const message of body.messages) {
    const deliverRes = await fetch(`${deliveryBaseUrl}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!deliverRes.ok) {
      throw new Error(`delivery stub rejected message ${message.id}: ${deliverRes.status}`);
    }
    delivered.push(message.id);
    // Names the generation this message was handed over at, not just the
    // id -- required so the shim can tell this claim apart from one a
    // lapsed-and-re-offered lease has since superseded.
    acks.push({ id: message.id, drainCount: message.drainCount });
  }

  if (!ack) {
    return { delivered, acked: [] };
  }

  const ackRes = await fetch(`${shimBaseUrl}/drain/ack`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${drainToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ acks }),
  });
  if (!ackRes.ok) {
    throw new Error(`POST /drain/ack -> ${ackRes.status}`);
  }
  const ackBody = await ackRes.json();
  return { delivered, acked: ackBody.acked };
}

async function enqueue(domain, apiKey, to, subject) {
  // Same shape Ghost's Mailgun-shaped client sends (mailgun.js's
  // messages.create -> multipart/form-data) -- built by hand here rather
  // than pulling mailgun.js into this dependency-free container, since the
  // wire format itself is already proven against the real client in
  // test/shim.integration.test.ts. This container's job is the network
  // topology and durability, not re-proving the multipart parser.
  const form = new FormData();
  form.append('to', to);
  form.append('from', `noreply@${domain}`);
  form.append('subject', subject);
  form.append('html', `<p>${subject}</p>`);
  form.append('text', subject);
  form.append('recipient-variables', '{}');

  const auth = Buffer.from(`api:${apiKey}`).toString('base64');
  const res = await fetch(`${shimBaseUrl}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`POST /v3/${domain}/messages -> ${res.status}`);
  }
  return res.json();
}

async function metrics() {
  const res = await fetch(`${shimBaseUrl}/metrics`);
  return res.text();
}

async function drainUnauthenticated(token) {
  const res = await fetch(`${shimBaseUrl}/drain`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.status;
}

const command = process.argv[2];
switch (command) {
  case 'enqueue': {
    const [, , , domain, apiKey, to, subject] = process.argv;
    console.log(JSON.stringify(await enqueue(domain, apiKey, to, subject)));
    break;
  }
  case 'drain-no-ack':
    console.log(JSON.stringify(await drainOnce({ ack: false })));
    break;
  case 'drain-and-ack':
    console.log(JSON.stringify(await drainOnce({ ack: true })));
    break;
  case 'metrics':
    console.log(await metrics());
    break;
  case 'drain-unauthenticated': {
    const token = process.argv[3];
    console.log(await drainUnauthenticated(token));
    break;
  }
  default:
    console.error(
      'Usage: collector.mjs <enqueue <domain> <apiKey> <to> <subject> | drain-no-ack | drain-and-ack | metrics | drain-unauthenticated [wrongToken]>'
    );
    process.exit(1);
}
