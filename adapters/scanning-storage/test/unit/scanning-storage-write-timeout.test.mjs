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

const require = createRequire(import.meta.url);
// The namespace, not destructured names, so a missing export fails the one
// test that uses it instead of the whole file.
const holdModule = require('../../src/hold.js');
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');
const { SafetyPolicy } = require('../../src/policy.js');
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { digestBytes } = require('../../src/pdq.js');
const GhostErrors = require('@tryghost/errors');

// A hung write must fail an assertion quickly, not wait out the default.
vi.setConfig({ testTimeout: 3000 });

const CLEAN_BYTES = Buffer.from('clean-image-bytes');
const CLEAN_DIGEST = digestBytes(CLEAN_BYTES);
const TARGET_PATH = '2026/10/upload.png';
const WRITE_TIMEOUT_MS = 30;
const RETRY_MS = 10;
const WAIT = { timeout: 1500, interval: 10 };
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NEVER_SETTLES = () => new Promise(() => {});

let tmpDir;
let quarantinePath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanning-storage-write-timeout-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine');
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// `logged` collects every logger.error call as an argument array.
function buildAdapter({ unavailable = [], holdMaxFailures } = {}) {
  const logged = [];
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  const verdictClient = new FakeVerdictClient({ unavailable });
  const checks = [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })];
  const adapter = new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: 'wrapped' },
    quarantinePath,
    checks,
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    writeTimeoutMs: WRITE_TIMEOUT_MS,
    holdRetryMs: RETRY_MS,
    holdMaxFailures,
    holdLogger: { error: (...args) => logged.push(args) },
  });
  return { adapter, verdictClient, logged };
}

async function writeTempFile(buffer, name = 'upload.png') {
  const filePath = path.join(tmpDir, `src-${crypto.randomBytes(4).toString('hex')}`);
  await fs.writeFile(filePath, buffer);
  return { name, path: filePath, type: 'image/png' };
}

// Both request-path writers, each driven to the same wrapped-adapter method
// that actually stores the bytes.
const WRITERS = {
  saveRaw: {
    wrappedMethod: 'saveRaw',
    run: (adapter) => adapter.saveRaw(CLEAN_BYTES, TARGET_PATH),
  },
  save: {
    wrappedMethod: 'save',
    run: async (adapter) => adapter.save(await writeTempFile(CLEAN_BYTES)),
  },
};
const WRITER_NAMES = Object.keys(WRITERS);

describe.each(WRITER_NAMES)('%s() when the wrapped write never settles', (writerName) => {
  const { wrappedMethod, run } = WRITERS[writerName];

  it('rejects with a plain Error naming the budget', async () => {
    const { adapter } = buildAdapter();
    adapter.wrapped[wrappedMethod] = NEVER_SETTLES;

    const err = await run(adapter).catch((caught) => caught);

    expect(err).toBeInstanceOf(Error);
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe(`write timed out after ${WRITE_TIMEOUT_MS} ms`);
  });

  it('logs exactly one line, starting with the request-write prefix, carrying the error', async () => {
    const { adapter, logged } = buildAdapter();
    adapter.wrapped[wrappedMethod] = NEVER_SETTLES;

    const err = await run(adapter).catch((caught) => caught);

    expect(logged).toHaveLength(1);
    expect(String(logged[0][0]).startsWith(holdModule.REQUEST_WRITE_TIMEOUT_LOG_PREFIX)).toBe(true);
    expect(logged[0][1]).toBe(err);
  });
});

describe('the request-write log prefix', () => {
  it('is the exact alertable string', () => {
    expect(holdModule.REQUEST_WRITE_TIMEOUT_LOG_PREFIX).toBe(
      'ScanningStorageAdapter: request write timed out'
    );
  });
});

describe.each(WRITER_NAMES)('%s() when the wrapped write finishes or fails on its own', (name) => {
  const { wrappedMethod, run } = WRITERS[name];

  it('returns the wrapped URL and logs nothing when the write settles in time', async () => {
    const { adapter, logged } = buildAdapter();

    const url = await run(adapter);

    expect(url).toMatch(/^https:\/\/example\.test\/content\/images\/.+\.png$/);
    expect(adapter.wrapped.files.size).toBe(1);
    expect(logged).toEqual([]);
  });

  it('rejects with the very same error and logs nothing when the write fails', async () => {
    const { adapter, logged } = buildAdapter();
    const failure = new Error('bucket unavailable');
    adapter.wrapped[wrappedMethod] = async () => {
      throw failure;
    };

    await expect(run(adapter)).rejects.toBe(failure);
    expect(logged).toEqual([]);
  });

  it('treats a storage error that merely reads like the timeout as an ordinary error', async () => {
    const { adapter, logged } = buildAdapter();
    const lookalike = new Error(`write timed out after ${WRITE_TIMEOUT_MS} ms`);
    adapter.wrapped[wrappedMethod] = async () => {
      throw lookalike;
    };

    await expect(run(adapter)).rejects.toBe(lookalike);
    expect(logged).toEqual([]);
  });
});

describe('a request-path write that settles after its timeout fired', () => {
  let unhandled;
  const onUnhandled = (reason) => unhandled.push(reason);

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('causes no unhandled rejection when it fails late', async () => {
    const { adapter } = buildAdapter();
    let failLate;
    adapter.wrapped.saveRaw = () =>
      new Promise((resolve, reject) => {
        failLate = reject;
      });
    await expect(adapter.saveRaw(CLEAN_BYTES, TARGET_PATH)).rejects.toThrow(
      'write timed out after'
    );

    failLate(new Error('failed after the timeout'));
    await settle(50);

    expect(unhandled).toEqual([]);
  });

  it('writes no second log line when it resolves late', async () => {
    const { adapter, logged } = buildAdapter();
    let finishLate;
    adapter.wrapped.saveRaw = () =>
      new Promise((resolve) => {
        finishLate = resolve;
      });
    await expect(adapter.saveRaw(CLEAN_BYTES, TARGET_PATH)).rejects.toThrow(
      'write timed out after'
    );

    finishLate('https://example.test/content/images/late.png');
    await settle(50);

    expect(unhandled).toEqual([]);
    expect(logged).toHaveLength(1);
  });
});

describe('the timer of a request-path write', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('is cleared once the write settles in time', async () => {
    const { adapter } = buildAdapter();

    await adapter.saveRaw(CLEAN_BYTES, TARGET_PATH);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('is cleared once the write fails in time', async () => {
    const { adapter } = buildAdapter();
    adapter.wrapped.saveRaw = async () => {
      throw new Error('bucket unavailable');
    };

    await adapter.saveRaw(CLEAN_BYTES, TARGET_PATH).catch(() => {});

    expect(vi.getTimerCount()).toBe(0);
  });

  it('is running while the write is pending, and fires at the budget', async () => {
    const { adapter } = buildAdapter();
    adapter.wrapped.saveRaw = NEVER_SETTLES;
    const outcome = adapter.saveRaw(CLEAN_BYTES, TARGET_PATH).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err.message).toBe(`write timed out after ${WRITE_TIMEOUT_MS} ms`);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a held upload whose promotion write never settles, through the adapter', () => {
  async function holdUntilStuck() {
    const built = buildAdapter({ unavailable: [CLEAN_DIGEST], holdMaxFailures: 2 });
    const { adapter, verdictClient } = built;
    const attempts = { count: 0 };
    adapter.wrapped.saveRaw = () => {
      attempts.count += 1;
      return NEVER_SETTLES();
    };
    await adapter.saveRaw(CLEAN_BYTES, TARGET_PATH);
    expect(adapter.hold.isPending(CLEAN_DIGEST)).toBe(true);

    verdictClient.deliverVerdict(CLEAN_DIGEST, { classification: 'no-known-match' });
    await vi.waitFor(() => expect(adapter.hold.isStuck(CLEAN_DIGEST)).toBe(true), WAIT);
    return { ...built, attempts };
  }

  it('leaves nothing at the held target', async () => {
    const { adapter } = await holdUntilStuck();

    expect([...adapter.wrapped.files.keys()]).toEqual([]);
  });

  it('keeps the quarantined bytes', async () => {
    await holdUntilStuck();

    const kept = await fs.readFile(path.join(quarantinePath, CLEAN_DIGEST));
    expect(kept.equals(CLEAN_BYTES)).toBe(true);
  });

  it('tried the write exactly as often as the failure limit, and no more once stuck', async () => {
    const { attempts } = await holdUntilStuck();
    expect(attempts.count).toBe(2);

    await settle(RETRY_MS * 10);

    expect(attempts.count).toBe(2);
  });
});
