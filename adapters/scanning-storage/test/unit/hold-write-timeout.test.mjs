import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
const { HoldRegistry, STUCK_LOG_PREFIX } = holdModule;
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { SafetyPolicy } = require('../../src/policy.js');
const GhostErrors = require('@tryghost/errors');

// A hung write must fail an assertion quickly, not wait out the default.
vi.setConfig({ testTimeout: 3000 });

const RETRY_MS = 10;
const WRITE_TIMEOUT_MS = 30;
const MAX_FAILURES = 2;
const DIGEST = 'digest';
const HELD_BYTES = Buffer.from('held-bytes');
const WAIT = { timeout: 1500, interval: 10 };
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ALLOW_CHECK = {
  kind: 'media',
  blocking: true,
  async run() {
    return { classification: 'no-known-match', evidence: DIGEST, source: 'test' };
  },
};

const ALLOW_POLICY = {
  decide() {
    return 'allow';
  },
};

let tmpDir;
let quarantinePath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hold-write-timeout-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine');
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function buildRegistry(overrides = {}) {
  return new HoldRegistry({
    checks: [ALLOW_CHECK],
    policy: ALLOW_POLICY,
    quarantinePath,
    owner: 'LocalImagesStorage:/var/lib/ghost/content/images',
    computeDigest: () => DIGEST,
    retryIntervalMs: RETRY_MS,
    maxConsecutiveFailures: MAX_FAILURES,
    writeTimeoutMs: WRITE_TIMEOUT_MS,
    logger: { error: () => {} },
    ...overrides,
  });
}

function buildAdapter(writeTimeoutMs) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  return new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: 'wrapped' },
    quarantinePath,
    checks: [],
    policy: new SafetyPolicy(),
    computeDigest: () => DIGEST,
    writeTimeoutMs,
    holdLogger: { error: () => {} },
  });
}

// What a promise has done so far, readable without awaiting it.
function watch(promise) {
  const state = { status: 'pending', value: undefined };
  promise.then(
    (value) => Object.assign(state, { status: 'resolved', value }),
    (error) => Object.assign(state, { status: 'rejected', value: error })
  );
  return state;
}

// A registry holding one digest whose promotion write never settles. The
// returned `logged` is every logger.error call, as an argument array.
async function holdWithNeverSettlingWrite() {
  const logged = [];
  const registry = buildRegistry({ logger: { error: (...args) => logged.push(args) } });
  const onAllow = vi.fn(() => new Promise(() => {}));
  await registry.hold(DIGEST, HELD_BYTES, { targetPath: 'a.png', onAllow, onRefuse: vi.fn() });
  return { registry, onAllow, logged };
}

describe('a hold whose promotion write never settles', () => {
  it('logs the first timed-out promotion as a failed retry carrying the timeout error', async () => {
    const { registry, logged } = await holdWithNeverSettlingWrite();
    await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), WAIT);

    const failedRetries = logged.filter(([line]) => String(line).includes('hold retry failed'));
    expect(failedRetries).toHaveLength(1);
    const [line, err] = failedRetries[0];
    expect(line).toContain(`(1 of ${MAX_FAILURES})`);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`write timed out after ${WRITE_TIMEOUT_MS} ms`);
  });

  it('marks the hold stuck after the second timeout and logs the stuck prefix', async () => {
    const { registry, logged } = await holdWithNeverSettlingWrite();
    await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), WAIT);

    expect(logged.some(([line]) => String(line).startsWith(STUCK_LOG_PREFIX))).toBe(true);
    expect(registry.stuckDigests()[0].reason).toContain('write timed out after');
  });

  it('says no further promotion will be attempted in the stuck line', async () => {
    const { registry, logged } = await holdWithNeverSettlingWrite();
    await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), WAIT);

    const stuckLine = logged
      .map(([line]) => String(line))
      .find((l) => l.startsWith(STUCK_LOG_PREFIX));
    expect(stuckLine).toContain('; no further promotion will be attempted');
  });

  it('keeps the bytes in quarantine once stuck', async () => {
    const { registry } = await holdWithNeverSettlingWrite();
    await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), WAIT);

    const kept = await fs.readFile(path.join(quarantinePath, DIGEST));
    expect(kept.equals(HELD_BYTES)).toBe(true);
  });

  it('calls onAllow exactly once per allowed retry up to the failure limit', async () => {
    const { registry, onAllow } = await holdWithNeverSettlingWrite();
    await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), WAIT);

    expect(onAllow).toHaveBeenCalledTimes(MAX_FAILURES);
  });

  it('starts no new promotion for a stuck hold, however long it waits', async () => {
    const { registry, onAllow } = await holdWithNeverSettlingWrite();
    await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), WAIT);

    await settle(RETRY_MS * 10);

    expect(onAllow).toHaveBeenCalledTimes(MAX_FAILURES);
  });

  it('still rejects a write that throws synchronously, as a failed retry carrying that error', async () => {
    const logged = [];
    const registry = buildRegistry({ logger: { error: (...args) => logged.push(args) } });
    const failure = new Error('simulated synchronous failure');
    const onAllow = vi.fn(() => {
      throw failure;
    });
    await registry.hold(DIGEST, HELD_BYTES, { targetPath: 'a.png', onAllow, onRefuse: vi.fn() });
    await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), WAIT);

    const failedRetry = logged.find(([line]) => String(line).includes('hold retry failed'));
    expect(failedRetry[1]).toBe(failure);
  });

  it('promotes normally and forgets the hold when the write settles in time', async () => {
    const logged = [];
    const registry = buildRegistry({ logger: { error: (...args) => logged.push(args) } });
    const onAllow = vi.fn(async () => {
      await settle(RETRY_MS / 2);
    });
    await registry.hold(DIGEST, HELD_BYTES, { targetPath: 'a.png', onAllow, onRefuse: vi.fn() });

    await vi.waitFor(() => expect(registry.isPending(DIGEST)).toBe(false), WAIT);

    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onAllow.mock.calls[0][0].equals(HELD_BYTES)).toBe(true);
    expect(registry.isStuck(DIGEST)).toBe(false);
    expect(logged).toEqual([]);
  });
});

describe('withWriteTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('rejects with a plain Error naming the budget once the budget passes', async () => {
    const state = watch(holdModule.withWriteTimeout(new Promise(() => {}), 50));

    await vi.advanceTimersByTimeAsync(50);

    expect(state.status).toBe('rejected');
    expect(state.value).toBeInstanceOf(Error);
    expect(state.value.constructor).toBe(Error);
    expect(state.value.message).toBe('write timed out after 50 ms');
  });

  it('resolves with the write result when it settles in time', async () => {
    const result = await holdModule.withWriteTimeout(Promise.resolve('stored'), 50);

    expect(result).toBe('stored');
  });

  it('accepts a write that is not a promise at all', async () => {
    const result = await holdModule.withWriteTimeout(undefined, 50);

    expect(result).toBeUndefined();
  });

  it('rejects with the write own error, unchanged, when the write fails in time', async () => {
    const failure = new Error('bucket unavailable');

    await expect(holdModule.withWriteTimeout(Promise.reject(failure), 50)).rejects.toBe(failure);
  });

  it('clears its timer when the write resolves in time', async () => {
    await holdModule.withWriteTimeout(Promise.resolve('stored'), 50);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the write fails in time', async () => {
    await holdModule.withWriteTimeout(Promise.reject(new Error('nope')), 50).catch(() => {});

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a running timer while the write is still pending', () => {
    holdModule.withWriteTimeout(new Promise(() => {}), 50);

    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('a write that settles after its timeout fired', () => {
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
    let failLate;
    const write = new Promise((resolve, reject) => {
      failLate = reject;
    });
    await expect(holdModule.withWriteTimeout(write, 20)).rejects.toThrow(
      'write timed out after 20 ms'
    );

    failLate(new Error('failed after the timeout'));
    await settle(50);

    expect(unhandled).toEqual([]);
  });

  it('causes no unhandled rejection when it resolves late', async () => {
    let finishLate;
    const write = new Promise((resolve) => {
      finishLate = resolve;
    });
    await expect(holdModule.withWriteTimeout(write, 20)).rejects.toThrow(
      'write timed out after 20 ms'
    );

    finishLate('stored after the timeout');
    await settle(50);

    expect(unhandled).toEqual([]);
  });
});

describe('the write timeout budget', () => {
  const JUNK_VALUES = [Infinity, 'abc', -1, 0, NaN, 2147483648];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('defaults to 60000 ms: still pending at 59999 ms and rejected at 60000 ms', async () => {
    const budget = holdModule.resolveWriteTimeoutMs(undefined);
    const state = watch(holdModule.withWriteTimeout(new Promise(() => {}), budget));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(state.status).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(state.status).toBe('rejected');
    expect(state.value.message).toBe('write timed out after 60000 ms');
  });

  it('uses an override of 50 ms: still pending at 49 ms and rejected at 50 ms', async () => {
    const budget = holdModule.resolveWriteTimeoutMs(50);
    const state = watch(holdModule.withWriteTimeout(new Promise(() => {}), budget));

    await vi.advanceTimersByTimeAsync(49);
    expect(state.status).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(state.status).toBe('rejected');
    expect(state.value.message).toBe('write timed out after 50 ms');
  });

  it('exports the default as 60000', () => {
    expect(holdModule.DEFAULT_WRITE_TIMEOUT_MS).toBe(60_000);
  });

  it.each([1, 50, 2147483647])('accepts %s as given, in the resolver', (value) => {
    expect(holdModule.resolveWriteTimeoutMs(value)).toBe(value);
  });

  it('gives a registry the resolved override', () => {
    expect(buildRegistry({ writeTimeoutMs: 50 }).writeTimeoutMs).toBe(50);
  });

  it('gives an adapter the resolved override', () => {
    expect(buildAdapter(50).writeTimeoutMs).toBe(50);
  });

  it.each(JUNK_VALUES)('falls back to the default for %s, in the resolver', (value) => {
    expect(holdModule.resolveWriteTimeoutMs(value)).toBe(holdModule.DEFAULT_WRITE_TIMEOUT_MS);
  });

  it.each(JUNK_VALUES)('falls back to 60000 for %s, in a registry', (value) => {
    expect(buildRegistry({ writeTimeoutMs: value }).writeTimeoutMs).toBe(60_000);
  });

  it.each(JUNK_VALUES)('falls back to 60000 for %s, in an adapter', (value) => {
    expect(buildAdapter(value).writeTimeoutMs).toBe(60_000);
  });

  it('falls back to 60000 when the option is not given at all', () => {
    expect(buildRegistry({ writeTimeoutMs: undefined }).writeTimeoutMs).toBe(60_000);
    expect(buildAdapter(undefined).writeTimeoutMs).toBe(60_000);
  });
});
