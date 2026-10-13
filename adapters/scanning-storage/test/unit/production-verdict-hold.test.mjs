import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import {
  FakeWrappedAdapter,
  makeLoadWrappedAdapterClass,
} from '../helpers/fake-wrapped-adapter.mjs';
import { captureLogger, fakeTransport, NEVER } from '../helpers/fake-verdict-transport.mjs';

const require = createRequire(import.meta.url);
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { ProductionVerdictClient } = require('../../src/production-verdict-client.js');
const { SafetyPolicy } = require('../../src/policy.js');
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { digestBytes } = require('../../src/pdq.js');
const GhostErrors = require('@tryghost/errors');

const CLEAN_BYTES = Buffer.from('clean-image-bytes');
const HELD_BYTES = Buffer.from('held-image-bytes');
const HELD_DIGEST = digestBytes(HELD_BYTES);

const RETRY_MS = 20;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WAIT = { timeout: 5000, interval: 10 };

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-verdict-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The real decorator, the real check and policy, and the production client
// over a fake transport. The transport's behaviour is a mutable `mode`, so a
// test can take the channel down and bring it back.
function build({ wrappedConfig, mode: initialMode = 'clean' }) {
  const state = { mode: initialMode };
  const { transport, record } = fakeTransport({
    connect: ({ connection }) => (state.mode === 'no-connect' ? NEVER() : connection),
    ask: async () => {
      if (state.mode === 'no-connect') {
        throw new Error('asked on a connection that never opened');
      }
      switch (state.mode) {
        case 'clean':
          return { classification: 'no-known-match' };
        case 'match':
          return { classification: 'csam', matchType: 'exact' };
        case 'silent':
          return new Promise(() => {});
        case 'down':
          throw new Error('peer reset');
        case 'malformed':
          return { classification: 'looks-fine' };
        default:
          throw new Error(`unknown mode ${state.mode}`);
      }
    },
  });
  const { logger, lines } = captureLogger();
  const verdictClient = new ProductionVerdictClient({
    transport,
    connectTimeoutMs: 20,
    totalTimeoutMs: 40,
    logger,
  });
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  const quarantinePath = path.join(tmpDir, 'quarantine');
  const instance = new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig,
    quarantinePath,
    checks: [
      createPdqKnownMaterialCheck(verdictClient, {
        computeDigest: digestBytes,
        // Read only by a check that asks about a separate key; one that asks
        // about the content digest ignores it.
        computeVerdictKey: async (buffer) => ({ hash: digestBytes(buffer), reason: null }),
      }),
    ],
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    holdRetryMs: RETRY_MS,
    holdLogger: { error: () => {} },
  });
  return { instance, state, record, lines, quarantinePath };
}

async function tempFile(buffer, name) {
  const filePath = path.join(tmpDir, `src-${crypto.randomBytes(4).toString('hex')}`);
  await fs.writeFile(filePath, buffer);
  return { name, path: filePath, type: 'image/png' };
}

function nothingWritten(adapter) {
  expect(adapter.wrapped.saved).toHaveLength(0);
  expect(adapter.wrapped.savedRaw).toHaveLength(0);
  expect(adapter.wrapped.files.size).toBe(0);
}

const BACKENDS = [
  ['local', { storagePath: 'wrapped' }],
  [
    'object storage',
    {
      storagePath: 'wrapped',
      bucket: 'test-bucket',
      cdnUrl: 'https://cdn.example.test/test-bucket',
    },
  ],
];

describe.each(BACKENDS)('production verdict source, %s backend', (_name, wrappedConfig) => {
  it('allow: a clean verdict inside the budget lets the bytes through', async () => {
    const { instance: adapter } = build({ wrappedConfig, mode: 'clean' });
    await adapter.save(await tempFile(CLEAN_BYTES, 'clean.png'));
    expect(adapter.wrapped.saved).toHaveLength(1);
  });

  it('refuse: a known match is refused with the typed 415 and nothing is written', async () => {
    const { instance: adapter } = build({ wrappedConfig, mode: 'match' });
    await expect(adapter.save(await tempFile(HELD_BYTES, 'bad.png'))).rejects.toMatchObject({
      statusCode: 415,
    });
    nothingWritten(adapter);
  });

  it.each([
    ['the channel never connects (connect timeout)', 'no-connect'],
    ['the channel never answers (total timeout)', 'silent'],
    ['the channel errors (transport error)', 'down'],
    ['the channel answers nonsense (malformed answer)', 'malformed'],
  ])(
    'hold: when %s the upload is accepted, held unserved, and no byte reaches storage',
    async (_label, mode) => {
      const { instance: adapter, record, lines, quarantinePath } = build({ wrappedConfig, mode });

      const url = await adapter.save(await tempFile(HELD_BYTES, 'held.png'));

      // Accepted, so the editor sees a URL; the URL serves nothing.
      expect(url).toContain(HELD_DIGEST);
      await expect(adapter.exists(url)).resolves.toBe(false);
      nothingWritten(adapter);
      await expect(
        fs.readFile(path.join(quarantinePath, `${HELD_DIGEST}.holds.json`))
      ).resolves.toBeTruthy();

      // The retry loop keeps dialling through the real client, and still
      // nothing gets through, however many answers fail to arrive.
      await vi.waitFor(() => expect(record.connects).toBeGreaterThanOrEqual(3), WAIT);
      await settle(RETRY_MS * 4);
      nothingWritten(adapter);
      expect(adapter.hold.isPending(HELD_DIGEST)).toBe(true);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines.every((line) => line.includes('VERDICT_UNAVAILABLE'))).toBe(true);
    }
  );

  it('control: a held upload is promoted when the channel later answers clean', async () => {
    const { instance: adapter, state } = build({ wrappedConfig, mode: 'down' });
    await adapter.save(await tempFile(HELD_BYTES, 'held.png'));
    await settle(RETRY_MS * 3);
    nothingWritten(adapter);

    state.mode = 'clean';
    await vi.waitFor(() => expect(adapter.hold.isPending(HELD_DIGEST)).toBe(false), WAIT);

    expect(adapter.wrapped.savedRaw).toHaveLength(1);
    expect(adapter.wrapped.savedRaw[0].buffer.equals(HELD_BYTES)).toBe(true);
  });

  it('control: a held upload the channel later matches is never promoted', async () => {
    const { instance: adapter, state } = build({ wrappedConfig, mode: 'silent' });
    await adapter.save(await tempFile(HELD_BYTES, 'held.png'));

    state.mode = 'match';
    await vi.waitFor(() => expect(adapter.hold.isPending(HELD_DIGEST)).toBe(false), WAIT);
    await settle(RETRY_MS * 3);

    nothingWritten(adapter);
  });
});
