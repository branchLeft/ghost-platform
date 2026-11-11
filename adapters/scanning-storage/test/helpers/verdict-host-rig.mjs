// A real host end on a temporary directory, with a clock the test can move and
// a stand-in for the safety service that signs requests the way the contract
// says. Nothing is mocked inside the host end: the sockets, the journal and
// the signature check are the shipped ones.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startVerdictHost } = require('../../verdict-host/service.js');

export const hashOf = (n) => Buffer.alloc(32, n).toString('base64');

export function makeClock() {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance: (ms) => {
      offset += ms;
    },
  };
}

export function quietLogger() {
  const lines = [];
  return { logger: { error: (line) => lines.push(String(line)) }, lines };
}

export function makeKeys(directory) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const keyFile = path.join(directory, 'channel-signing.pub');
  fs.writeFileSync(keyFile, `${raw.toString('base64')}\n`, { mode: 0o600 });
  return { privateKey, keyFile };
}

export function signHeaders(privateKey, method, url, body, { now, nonce } = {}) {
  const timestamp = String(Math.floor((now ?? Date.now()) / 1000));
  const usedNonce = nonce ?? crypto.randomBytes(16).toString('hex');
  const payload = Buffer.concat([
    Buffer.from(`${method}\n${url}\n${timestamp}\n${usedNonce}\n`, 'utf8'),
    Buffer.from(body, 'utf8'),
  ]);
  return {
    'x-broker-timestamp': timestamp,
    'x-broker-nonce': usedNonce,
    'x-broker-signature': crypto.sign(null, payload, privateKey).toString('base64'),
  };
}

export function newTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vh-'));
}

export async function startRig({
  directory = newTempDir(),
  config = {},
  clock = makeClock(),
} = {}) {
  const keys = makeKeys(directory);
  const { logger, lines } = quietLogger();
  const fullConfig = {
    socketPath: path.join(directory, 'v.sock'),
    socketMode: 0o600,
    journalFile: path.join(directory, 'state', 'queue.journal'),
    verifyKeyFile: keys.keyFile,
    metricsFile: path.join(directory, 'metrics', 'verdict_host.prom'),
    inboundHost: '127.0.0.1',
    inboundPort: 0,
    holdMs: 150,
    leaseMs: 120_000,
    reofferDelayMs: 30_000,
    verdictTtlMs: 600_000,
    askWaitMs: 300,
    maxQueued: 10_000,
    replayWindowSeconds: 60,
    ...config,
  };
  const host = await startVerdictHost(fullConfig, { logger, now: clock.now });
  // The first second after a start is the replay floor: move past it.
  clock.advance(2000);
  const base = `http://127.0.0.1:${host.inbound.address.port}`;

  // The stand-in for the safety service. `signAs` lets a test send a request
  // signed for a different method or path than the one it sends.
  async function call(method, url, { body = '', headers, signAs } = {}) {
    const signed =
      headers ??
      signHeaders(keys.privateKey, signAs?.method ?? method, signAs?.url ?? url, body, {
        now: clock.now(),
      });
    return fetch(`${base}${url}`, {
      method,
      headers: signed,
      body: method === 'GET' ? undefined : body,
    });
  }
  const poll = async () => (await call('GET', '/safety/v1/pending')).json();
  const post = (batch, verdicts) =>
    call('POST', '/safety/v1/verdicts', { body: JSON.stringify({ v: 1, batch, verdicts }) });

  return {
    host,
    config: fullConfig,
    directory,
    clock,
    keys,
    lines,
    base,
    call,
    poll,
    post,
    async stop() {
      await host.stop();
    },
    async cleanup() {
      await host.stop().catch(() => {});
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export const verdictFor = (hash, overrides = {}) => ({
  hash,
  classification: 'no-known-match',
  source: 'test-source',
  decision: { action: 'allow' },
  audited: true,
  ...overrides,
});
