// The entry file Ghost loads, with `verdictSource=production` and a socket
// path in its config: the transport it builds is the real unix-socket one,
// and the far end is either a scripted line server or the real host end.
// Ghost's storage base and the wrapped adapter are the suite's doubles, as in
// entry-production-source.test.mjs; everything else is the real entry file.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import { FakeWrappedAdapter } from '../helpers/fake-wrapped-adapter.mjs';
import { startRig } from '../helpers/verdict-host-rig.mjs';

const require = createRequire(import.meta.url);
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
const WRAPPED_PATH = path.join(SRC_DIR, 'FakeAdapter');
NodeModule._load = function patchedLoad(request, ...rest) {
  if (request === 'ghost-storage-base') {
    return { StorageBase: FakeStorageBase };
  }
  if (request === WRAPPED_PATH) {
    return FakeWrappedAdapter;
  }
  return originalLoad.call(this, request, ...rest);
};
afterAll(() => {
  NodeModule._load = originalLoad;
});

const EntryAdapter = require('../../src/ScanningStorageAdapter.js');
const { digestBytes } = require('../../src/pdq.js');

const CLEAN_BYTES = Buffer.from('clean-image-bytes');
const BAD_BYTES = Buffer.from('known-bad-image-bytes');
const WAIT = { timeout: 5000, interval: 10 };
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tmpDir;
let servers;
let rig;

beforeEach(async () => {
  // A short directory: a unix socket path has a small length limit.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'est-'));
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await rig?.cleanup();
  rig = undefined;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A line server on a unix socket: it reads one ask and answers with whatever
// `answerFor(key)` gives, echoing the asked key, as the host end does.
async function lineServer(answerFor) {
  const socketPath = path.join(tmpDir, 'v.sock');
  const asked = [];
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffered += chunk;
      const end = buffered.indexOf('\n');
      if (end === -1) return;
      const ask = JSON.parse(buffered.slice(0, end));
      asked.push(ask.key);
      socket.end(`${JSON.stringify({ v: 1, key: ask.key, ...answerFor(ask.key) })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  servers.push(server);
  return { socketPath, asked };
}

function build(extra = {}) {
  return new EntryAdapter({
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: 'wrapped' },
    quarantinePath: path.join(tmpDir, 'quarantine'),
    holdRetryMs: 20,
    holdLogger: { error: () => {} },
    verdictConnectTimeoutMs: '200',
    verdictTotalTimeoutMs: '1500',
    ...extra,
  });
}

function nothingWritten(adapter) {
  expect(adapter.wrapped.saved).toHaveLength(0);
  expect(adapter.wrapped.savedRaw).toHaveLength(0);
  expect(adapter.wrapped.files.size).toBe(0);
}

describe('the entry file passes the socket transport for verdictSource=production', () => {
  it('allow: a clean answer on the socket lets the upload through to storage', async () => {
    const { socketPath, asked } = await lineServer(() => ({ classification: 'no-known-match' }));
    const adapter = build({ verdictSource: 'production', verdictSocketPath: socketPath });

    await adapter.saveRaw(CLEAN_BYTES, '2026/11/clean.png');

    expect(asked).toEqual([digestBytes(CLEAN_BYTES)]);
    expect(adapter.wrapped.savedRaw).toHaveLength(1);
    expect(adapter.wrapped.savedRaw[0].buffer.equals(CLEAN_BYTES)).toBe(true);
  });

  it('refuse: a known match on the socket is refused with the typed 415', async () => {
    const { socketPath } = await lineServer(() => ({
      classification: 'csam',
      matchType: 'exact',
    }));
    const adapter = build({ verdictSource: 'production', verdictSocketPath: socketPath });

    await expect(adapter.saveRaw(BAD_BYTES, '2026/11/bad.png')).rejects.toMatchObject({
      statusCode: 415,
    });
    nothingWritten(adapter);
  });

  it('hold: with nothing listening on the path, the upload is accepted and held, never served', async () => {
    const adapter = build({
      verdictSource: 'production',
      verdictSocketPath: path.join(tmpDir, 'nobody.sock'),
    });

    await adapter.saveRaw(CLEAN_BYTES, '2026/11/held.png');
    await settle(80);

    nothingWritten(adapter);
    expect(adapter.hold.isPending(digestBytes(CLEAN_BYTES))).toBe(true);
  });

  it('hold: against the real host end, an upload stays held until a verdict exists', async () => {
    // The host end accepts only a PDQ key, and the decorator's digest is
    // still a SHA-256 stand-in (pdq.js), so today the host end refuses the
    // ask and the upload is held. A hold is the only acceptable outcome:
    // never an allow, never a refusal as unconfigured.
    rig = await startRig({ config: { askWaitMs: 100 } });
    const adapter = build({
      verdictSource: 'production',
      verdictSocketPath: rig.config.socketPath,
    });

    await adapter.saveRaw(CLEAN_BYTES, '2026/11/held.png');
    await settle(80);

    nothingWritten(adapter);
    expect(adapter.hold.isPending(digestBytes(CLEAN_BYTES))).toBe(true);
  });

  it('control: a held upload is promoted once the socket answers clean', async () => {
    let answer = null;
    const { socketPath } = await lineServer(() =>
      answer === null ? { classification: 'unavailable' } : answer
    );
    const adapter = build({ verdictSource: 'production', verdictSocketPath: socketPath });

    await adapter.saveRaw(CLEAN_BYTES, '2026/11/held.png');
    await settle(60);
    nothingWritten(adapter);

    answer = { classification: 'no-known-match' };
    await vi.waitFor(() => expect(adapter.wrapped.savedRaw).toHaveLength(1), WAIT);
  });
});

// The path is the only thing that selects a socket. With none, or one the
// transport refuses, `production` has no source and refuses as unconfigured:
// nothing guesses a default path, which would turn a missing setting into a
// silent hold of every upload.
describe('the entry file and a missing or bad socket path', () => {
  it.each([
    ['no socket path', {}],
    ['an empty socket path', { verdictSocketPath: '' }],
    ['a relative socket path', { verdictSocketPath: 'run/v.sock' }],
    ['a socket path that is not a string', { verdictSocketPath: 7 }],
  ])('control: production with %s refuses every upload with the typed 503', async (_l, extra) => {
    const adapter = build({ verdictSource: 'production', ...extra });
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/11/clean.png')).rejects.toMatchObject({
      statusCode: 503,
    });
    nothingWritten(adapter);
  });

  it('control: a socket path without verdictSource=production selects nothing', async () => {
    const { socketPath, asked } = await lineServer(() => ({ classification: 'no-known-match' }));
    const adapter = build({ verdictSocketPath: socketPath });
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/11/clean.png')).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(asked).toEqual([]);
    nothingWritten(adapter);
  });
});
