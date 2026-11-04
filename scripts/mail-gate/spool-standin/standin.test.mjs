// The stand-in spool must refuse what the real mailgun-shim refuses, or the mail
// gate's PR job passes on a send the pinned spool would turn away.
// The control is the sender-domain check: a credential may only send as its own
// registered sender domain, on the Mailgun route (400) and at SMTP MAIL FROM
// (553). No Docker: this spawns server.js and cli.js on ephemeral ports.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
// The files are CommonJS because the image has no package.json; this repo's
// is "type": "module". So the test runs copies laid out as the Dockerfile does.
let SERVER;
let CLI;
const DOMAIN = 'gate-slot0.example.com';
const TOKEN = 'drain-token-for-the-standin-test';

let dir;
let server;
let ports;
let key;
let env;

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const runCli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-test-'));
  fs.mkdirSync(path.join(dir, 'app', 'dist'), { recursive: true });
  SERVER = path.join(dir, 'app', 'server.js');
  CLI = path.join(dir, 'app', 'dist', 'cli.js');
  fs.copyFileSync(path.join(HERE, 'server.js'), SERVER);
  fs.copyFileSync(path.join(HERE, 'cli.js'), CLI);
  ports = { http: await freePort(), drain: await freePort(), smtp: await freePort() };
  env = { ...process.env, SHIM_KEYS_PATH: path.join(dir, 'keys.json') };
  const registered = runCli('register', DOMAIN, '--sender-domain', DOMAIN);
  assert.equal(registered.status, 0, registered.stderr);
  key = registered.stdout.trim().split('\n').pop();
  server = spawn(process.execPath, [SERVER], {
    env: {
      ...env,
      PORT: String(ports.http),
      SHIM_DRAIN_PORT: String(ports.drain),
      SMTP_LISTEN_PORT: String(ports.smtp),
      SHIM_DRAIN_TOKEN: TOKEN,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${ports.http}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('stand-in server did not come up');
});

after(() => {
  server?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function postMessage(from, { apiKey = key, domain = DOMAIN } = {}) {
  const form = new FormData();
  form.append('from', from);
  form.append('to', 'harness@example.com');
  form.append('subject', 'Gate');
  form.append('text', 'Gate');
  const res = await fetch(`http://127.0.0.1:${ports.http}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` },
    body: form,
  });
  return { status: res.status, body: await res.text() };
}

async function drained() {
  const res = await fetch(`http://127.0.0.1:${ports.drain}/drain`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return (await res.json()).messages;
}

// One SMTP conversation: send a line, read the reply's final status line.
async function smtp(lines) {
  const socket = net.connect(ports.smtp, '127.0.0.1');
  let buf = '';
  let wake = () => {};
  socket.on('data', (c) => {
    buf += c.toString('utf8');
    wake();
  });
  const reply = async () => {
    for (;;) {
      const done = buf.endsWith('\r\n') && /^\d{3} /.test(buf.trimEnd().split('\r\n').pop());
      if (done) {
        const out = buf.trimEnd().split('\r\n').pop();
        buf = '';
        return out;
      }
      await new Promise((r) => {
        wake = r;
      });
    }
  };
  await reply();
  const replies = [];
  for (const line of lines) {
    socket.write(`${line}\r\n`);
    replies.push(await reply());
  }
  socket.destroy();
  return replies;
}

const authPlain = () => `AUTH PLAIN ${Buffer.from(`\0${DOMAIN}\0${key}`).toString('base64')}`;

test('register refuses without --sender-domain, as the real CLI does', () => {
  const r = runCli('register', 'other.example.com');
  assert.notEqual(r.status, 0, 'a register with no sender domain must fail');
});

test('a From in the registered sender domain is accepted and queued', async () => {
  const sent = await postMessage('"Site" <noreply@gate-slot0.example.com>');
  assert.equal(sent.status, 200, sent.body);
  const messages = await drained();
  assert.ok(messages.some((m) => m.from.includes('noreply@gate-slot0.example.com')));
});

test('the domain compare ignores case and a trailing dot', async () => {
  const sent = await postMessage('Site <noreply@GATE-Slot0.Example.COM.>');
  assert.equal(sent.status, 200, sent.body);
});

test('a From outside the sender domain is refused 400 with the real shim wording', async () => {
  const sent = await postMessage('"Site" <noreply@localhost>');
  assert.equal(sent.status, 400, sent.body);
  assert.equal(JSON.parse(sent.body).message, `'from' address must belong to the domain ${DOMAIN}`);
});

test('every From mailbox must be in the sender domain', async () => {
  const sent = await postMessage(`noreply@${DOMAIN}, someone@evil.example`);
  assert.equal(sent.status, 400, sent.body);
});

test('a lookalike domain is refused', async () => {
  const sent = await postMessage(`noreply@evil-${DOMAIN}`);
  assert.equal(sent.status, 400, sent.body);
});

test('a wrong key is still 401, before any From check', async () => {
  const sent = await postMessage(`noreply@${DOMAIN}`, { apiKey: 'wrong' });
  assert.equal(sent.status, 401, sent.body);
});

test('SMTP MAIL FROM outside the sender domain gets 553, inside gets 250', async () => {
  const [ehlo, auth, foreign, own] = await smtp([
    'EHLO test',
    authPlain(),
    'MAIL FROM:<noreply@localhost>',
    `MAIL FROM:<noreply@${DOMAIN}>`,
  ]);
  assert.match(ehlo, /^250 /);
  assert.match(auth, /^235 /);
  assert.match(foreign, /^553 /, 'a foreign envelope sender must be refused');
  assert.match(own, /^250 /, 'the registered domain must be accepted');
});
