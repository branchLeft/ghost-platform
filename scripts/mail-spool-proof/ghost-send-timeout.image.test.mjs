// Drives the built Ghost image against a listener that accepts and never
// greets, which is what a frozen spool looks like to Ghost. The mail timeouts
// are the ones render-core renders, read from its demo golden. Ghost's own
// reader send (a sign-up magic link) must end in failure inside BOUND_MS.
// The negative control boots Ghost with the timeouts omitted: that request
// must still be open at BOUND_MS, or end clearly later than the rendered
// greeting timeout. Rationale: ghost-send-timeout.md.
//
// Usage:
//   IMAGE=ghost-platform:ci node --test scripts/mail-spool-proof/ghost-send-timeout.image.test.mjs
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  docker,
  pollHttp200,
  reservePort,
  runStep,
  sleep,
} from '../../test-support/image-harness.mjs';

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(HERE, '../../render-core/test/golden/demo.compose.yml');
const SITE_URL = 'https://tenant.example.test';
const BOUND_MS = 15_000;
// The negative control stops this long after BOUND_MS, not at nodemailer's 30 s.
const NEGATIVE_MARGIN_MS = 2_000;
// The untimed Ghost must end at least this much later than the rendered greeting timeout.
const UNTIMED_LATER_BY_MS = 3_000;
const CLIENT_DEADLINE_MS = 60_000;
const BOOT_TIMEOUT_MS = 90_000;
const LABEL = 'branchleft.agent=ghost-send-timeout-image-test';
const TIMEOUT_KEYS = ['connectionTimeout', 'greetingTimeout', 'socketTimeout'];

// The three mail timeouts the first Ghost service in the golden renders.
async function renderedMailTimeouts() {
  const text = await fs.readFile(GOLDEN, 'utf8');
  const timeouts = {};
  for (const key of TIMEOUT_KEYS) {
    const match = text.match(new RegExp(`^\\s+mail__options__${key}: (\\d+)$`, 'm'));
    assert.ok(match, `the golden renders mail__options__${key}`);
    timeouts[`mail__options__${key}`] = match[1];
  }
  return timeouts;
}

// Accepts every connection and never writes a byte. `accepted` is the evidence
// that Ghost's mailer dialled it: one line per connection, with the time.
function startHungListener() {
  const held = [];
  const accepted = [];
  const server = net.createServer((socket) => {
    held.push(socket);
    accepted.push({ at: Date.now(), from: `${socket.remoteAddress}:${socket.remotePort}` });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      resolve({
        port: server.address().port,
        held,
        accepted,
        close: () => {
          for (const socket of held) socket.destroy();
          server.close();
        },
      });
    });
  });
}

class GhostContainer {
  static async start(smtpPort, withTimeouts = true) {
    return runStep('start Ghost container', () => GhostContainer.#start(smtpPort, withTimeouts), {
      deadlineMs: BOOT_TIMEOUT_MS + 60_000,
    });
  }

  static async #start(smtpPort, withTimeouts) {
    const port = await reservePort();
    const name = `ghost-send-timeout-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const env = {
      url: SITE_URL,
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      privacy__useUpdateCheck: 'false',
      BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
      storage__images__adapter: 'ScanningStorageAdapter',
      storage__images__wraps: 'LocalImagesStorage',
      storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
      storage__media__adapter: 'ScanningStorageAdapter',
      storage__media__wraps: 'LocalMediaStorage',
      storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
      storage__files__adapter: 'ScanningStorageAdapter',
      storage__files__wraps: 'LocalFilesStorage',
      storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
      mail__transport: 'SMTP',
      mail__from: 'noreply@example.test',
      mail__options__host: 'host.docker.internal',
      mail__options__port: String(smtpPort),
      mail__options__secure: 'false',
      ...(withTimeouts ? await renderedMailTimeouts() : {}),
    };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    docker(
      'create',
      '--name',
      name,
      '--label',
      LABEL,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-p',
      `127.0.0.1:${port}:2368`,
      ...envArgs,
      IMAGE
    );
    const container = new GhostContainer(name, port);
    docker('start', name);
    const booted = await container.waitForHome();
    assert.ok(booted.ok, `Ghost did not boot (${booted.detail}): ${container.logs()}`);
    return container;
  }

  constructor(name, port) {
    this.name = name;
    this.port = port;
  }

  waitForHome() {
    return pollHttp200(`http://127.0.0.1:${this.port}/`, {
      containerName: this.name,
      deadlineMs: BOOT_TIMEOUT_MS,
      probe: (signal) => this.request('GET', '/', undefined, {}, signal).then((res) => res.status),
    });
  }

  logs() {
    try {
      return docker('logs', '--tail', '40', this.name);
    } catch {
      return '';
    }
  }

  stop() {
    try {
      docker('rm', '-f', this.name);
    } catch {
      // Already gone.
    }
  }

  // The request an outsider's browser makes, as the proxy forwards it.
  request(method, path, body, extraHeaders = {}, signal) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          method,
          path,
          signal,
          headers: {
            'content-type': 'application/json',
            host: new URL(SITE_URL).host,
            origin: SITE_URL,
            'x-forwarded-proto': 'https',
            ...extraHeaders,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        }
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}

// The members API refuses a magic-link POST without the integrity token the
// theme fetches first (verifyRequestIntegrity, router-controller's 400).
// Returns the POST as a function so the token fetch stays outside the timing.
async function prepareMagicLink(container, signal) {
  const tokenRes = await container.request(
    'GET',
    '/members/api/integrity-token/',
    undefined,
    {},
    signal
  );
  assert.equal(
    tokenRes.status,
    200,
    `integrity token answered ${tokenRes.status}: ${tokenRes.text}`
  );
  const email = `reader-${crypto.randomBytes(3).toString('hex')}@example.test`;
  return () =>
    container.request(
      'POST',
      '/members/api/send-magic-link/',
      { email, emailType: 'signup', integrityToken: tokenRes.text, redirect: `${SITE_URL}/` },
      {},
      signal
    );
}

function connectionEvidence(listener, before, startedAt) {
  const seen = listener.accepted.slice(before);
  return seen.length === 0
    ? 'listener accepted no connection'
    : `listener accepted ${seen.length} connection(s): ${seen
        .map((c) => `${c.from} at +${c.at - startedAt} ms`)
        .join(', ')}`;
}

describe('Ghost send against a listener that never greets', () => {
  let listener;
  let ghost;
  let untimed;
  let timeouts;

  before(async () => {
    timeouts = await renderedMailTimeouts();
    listener = await startHungListener();
    const boots = await Promise.allSettled([
      GhostContainer.start(listener.port, true),
      GhostContainer.start(listener.port, false),
    ]);
    [ghost, untimed] = boots.map((boot) => boot.value);
    const failed = boots.find((boot) => boot.status === 'rejected');
    if (failed) throw failed.reason;
  });

  after(() => {
    ghost?.stop();
    untimed?.stop();
    listener?.close();
  });

  it('the rendered connection and greeting timeouts fit inside the bound', () => {
    const connectAndGreet =
      Number(timeouts.mail__options__connectionTimeout) +
      Number(timeouts.mail__options__greetingTimeout);
    assert.ok(connectAndGreet <= BOUND_MS, `connection + greeting is ${connectAndGreet} ms`);
  });

  it("a reader's magic-link request ends in failure within the bound", async (t) => {
    const send = await prepareMagicLink(ghost, AbortSignal.timeout(CLIENT_DEADLINE_MS));
    const before = listener.accepted.length;
    const started = Date.now();
    const res = await send();
    const elapsed = Date.now() - started;
    const evidence = connectionEvidence(listener, before, started);
    t.diagnostic(
      `with timeouts: status ${res.status} in ${elapsed} ms, bound ${BOUND_MS} ms; ${evidence}; body ${res.text}`
    );
    assert.ok(
      listener.accepted.length > before,
      `Ghost never dialled the listener: ${res.status} ${res.text}`
    );
    // ghost-mailer.js createMailError: a failed send is a 500 EmailError.
    assert.equal(res.status, 500, `Ghost's failed send answered ${res.status}: ${res.text}`);
    assert.ok(
      res.text.includes('Greeting never received') || res.text.includes('ETIMEDOUT'),
      `Ghost's 500 is not the greeting timeout: ${res.text}`
    );
    assert.ok(elapsed <= BOUND_MS, `the reader's request took ${elapsed} ms, past ${BOUND_MS} ms`);
    const greeting = Number(timeouts.mail__options__greetingTimeout);
    assert.ok(
      elapsed >= greeting - 500,
      `ended in ${elapsed} ms, before the ${greeting} ms greeting timeout`
    );
  });

  it('without the timeouts the same request is still open at the bound', async (t) => {
    const controller = new AbortController();
    const send = await prepareMagicLink(untimed, controller.signal);
    const before = listener.accepted.length;
    const started = Date.now();
    const finished = send().then(
      (res) => ({ status: res.status, text: res.text, elapsed: Date.now() - started }),
      (err) => ({ status: `error ${err.name}`, text: '', elapsed: Date.now() - started })
    );
    const stopAt = sleep(BOUND_MS + NEGATIVE_MARGIN_MS).then(() => null);
    const outcome = await Promise.race([finished, stopAt]);
    const waited = Date.now() - started;
    const evidence = connectionEvidence(listener, before, started);
    controller.abort();
    t.diagnostic(
      outcome === null
        ? `without timeouts: still open at ${waited} ms, bound ${BOUND_MS} ms; ${evidence}`
        : `without timeouts: status ${outcome.status} in ${outcome.elapsed} ms, bound ${BOUND_MS} ms; ${evidence}; body ${outcome.text}`
    );
    assert.ok(
      listener.accepted.length > before,
      `the untimed Ghost never dialled the listener: ${evidence}`
    );
    // Ghost 6.76's mailer has a greeting timeout of its own (10 s), so the untimed
    // request may now end before the bound. What the control must show is that the
    // rendered 5 s timeout is what ended the timed request: the untimed one is
    // still open, or ended clearly later.
    const greeting = Number(timeouts.mail__options__greetingTimeout);
    assert.ok(
      outcome === null || outcome.elapsed >= greeting + UNTIMED_LATER_BY_MS,
      `without the timeouts the request finished in ${outcome?.elapsed} ms (${outcome?.status}), not clearly later than the ${greeting} ms greeting timeout`
    );
  });
});
