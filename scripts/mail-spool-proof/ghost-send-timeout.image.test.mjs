// Drives the built Ghost image against a listener that accepts and never
// greets, which is what a frozen spool looks like to Ghost. The mail timeouts
// are the ones render-core renders, read from its demo golden. Ghost's own
// reader send (a sign-up magic link) must end in failure inside BOUND_MS.
// Rationale: ghost-send-timeout.md.
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
import { docker, pollHttp200, reservePort, runStep } from '../../test-support/image-harness.mjs';

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(HERE, '../../render-core/test/golden/demo.compose.yml');
const SITE_URL = 'https://tenant.example.test';
const BOUND_MS = 15_000;
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

// Accepts every connection and never writes a byte.
function startHungListener() {
  const held = [];
  const server = net.createServer((socket) => {
    held.push(socket);
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      resolve({
        port: server.address().port,
        held,
        close: () => {
          for (const socket of held) socket.destroy();
          server.close();
        },
      });
    });
  });
}

class GhostContainer {
  static async start(smtpPort) {
    return runStep('start Ghost container', () => GhostContainer.#start(smtpPort), {
      deadlineMs: BOOT_TIMEOUT_MS + 60_000,
    });
  }

  static async #start(smtpPort) {
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
      ...(await renderedMailTimeouts()),
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

describe('Ghost send against a listener that never greets', () => {
  let listener;
  let ghost;
  let timeouts;

  before(async () => {
    timeouts = await renderedMailTimeouts();
    listener = await startHungListener();
    ghost = await GhostContainer.start(listener.port);
  });

  after(() => {
    ghost?.stop();
    listener?.close();
  });

  it('the rendered connection and greeting timeouts fit inside the bound', () => {
    const connectAndGreet =
      Number(timeouts.mail__options__connectionTimeout) +
      Number(timeouts.mail__options__greetingTimeout);
    assert.ok(connectAndGreet <= BOUND_MS, `connection + greeting is ${connectAndGreet} ms`);
  });

  it("a reader's magic-link request ends in failure within the bound", async () => {
    const email = `reader-${crypto.randomBytes(3).toString('hex')}@example.test`;
    const started = Date.now();
    const res = await ghost.request(
      'POST',
      '/members/api/send-magic-link/',
      { email, emailType: 'signup', redirect: `${SITE_URL}/` },
      {},
      AbortSignal.timeout(CLIENT_DEADLINE_MS)
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed <= BOUND_MS, `the reader's request took ${elapsed} ms, past ${BOUND_MS} ms`);
    assert.ok(res.status >= 400, `Ghost's send did not fail: status ${res.status}`);
    assert.ok(listener.held.length >= 1, 'Ghost never dialled the listener');
  });
});
