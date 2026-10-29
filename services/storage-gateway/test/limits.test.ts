import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { admit, type RefusalLogEntry } from '../src/admit.js';
import type {
  AllowedOperation,
  CredentialRecord,
  CredentialStore,
  GatewayRequest,
  SignatureVerifier,
} from '../src/contracts.js';
import {
  WRITE_OPERATIONS,
  createQuotaMonitor,
  createTenantLimits,
  createTenantRateLimiter,
  createWriteKillSwitches,
  type QuotaAlert,
  type QuotaUsage,
  type TenantLimits,
} from '../src/limits/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gateway-limits-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ALL: readonly AllowedOperation[] = [
  'PutObject',
  'CreateMultipartUpload',
  'UploadPart',
  'CompleteMultipartUpload',
  'AbortMultipartUpload',
  'HeadObject',
  'GetObject',
];

function clock(start = 1_000_000) {
  let now = start;
  return {
    nowMs: () => now,
    advance: (ms: number) => void (now += ms),
    set: (ms: number) => void (now = ms),
  };
}

describe('per-tenant rate limit', () => {
  it('allows a burst, then refuses with a retry hint, then allows again as tokens refill', () => {
    const c = clock();
    const limiter = createTenantRateLimiter({
      default: { perSecond: 10, burst: 3 },
      nowMs: c.nowMs,
    });
    expect(limiter.take('a')).toEqual({ allowed: true });
    expect(limiter.take('a')).toEqual({ allowed: true });
    expect(limiter.take('a')).toEqual({ allowed: true });
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterMs: 100 });
    c.advance(50);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterMs: 50 });
    c.advance(50);
    expect(limiter.take('a')).toEqual({ allowed: true });
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('leaves every other tenant untouched when one is over its rate', () => {
    const c = clock();
    const limiter = createTenantRateLimiter({
      default: { perSecond: 1, burst: 2 },
      nowMs: c.nowMs,
    });
    for (let i = 0; i < 50; i += 1) limiter.take('noisy');
    expect(limiter.take('noisy').allowed).toBe(false);
    expect(limiter.take('quiet')).toEqual({ allowed: true });
    expect(limiter.take('quiet')).toEqual({ allowed: true });
    expect(limiter.take('quiet').allowed).toBe(false);
  });

  it('never holds more than the burst however long a tenant was quiet', () => {
    const c = clock();
    const limiter = createTenantRateLimiter({
      default: { perSecond: 100, burst: 2 },
      nowMs: c.nowMs,
    });
    limiter.take('a');
    c.advance(3_600_000);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('mints nothing when the clock steps backwards', () => {
    const c = clock();
    const limiter = createTenantRateLimiter({
      default: { perSecond: 1, burst: 1 },
      nowMs: c.nowMs,
    });
    expect(limiter.take('a').allowed).toBe(true);
    c.advance(-5000);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('gives a tenant with its own rate that rate', () => {
    const c = clock();
    const limiter = createTenantRateLimiter({
      default: { perSecond: 1, burst: 1 },
      overrides: { big: { perSecond: 1, burst: 5 } },
      nowMs: c.nowMs,
    });
    expect(Array.from({ length: 6 }, () => limiter.take('big').allowed)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(limiter.take('small').allowed).toBe(true);
    expect(limiter.take('small').allowed).toBe(false);
  });

  it('refuses a rate that is not usable', () => {
    for (const bad of [
      { perSecond: 0, burst: 1 },
      { perSecond: -1, burst: 1 },
      { perSecond: Number.NaN, burst: 1 },
      { perSecond: 1, burst: 0 },
      { perSecond: 1, burst: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => createTenantRateLimiter({ default: bad })).toThrow(RangeError);
      expect(() =>
        createTenantRateLimiter({ default: { perSecond: 1, burst: 1 }, overrides: { k: bad } })
      ).toThrow(RangeError);
    }
  });

  it('works on the real clock', () => {
    const limiter = createTenantRateLimiter({ default: { perSecond: 1000, burst: 1 } });
    expect(limiter.take('a').allowed).toBe(true);
  });
});

describe('write kill switches', () => {
  it('stops one tenant writing and leaves every other tenant writing', () => {
    const switches = createWriteKillSwitches();
    switches.setTenant('stopped', true);
    expect(switches.writesBlocked('stopped')).toBe(true);
    expect(switches.writesBlocked('other')).toBe(false);
    switches.setTenant('stopped', false);
    expect(switches.writesBlocked('stopped')).toBe(false);
  });

  it('stops every tenant writing with the global switch', () => {
    const switches = createWriteKillSwitches();
    switches.setGlobal(true);
    expect(switches.writesBlocked('a')).toBe(true);
    expect(switches.writesBlocked('b')).toBe(true);
    switches.setGlobal(false);
    expect(switches.writesBlocked('a')).toBe(false);
  });

  it('covers the four operations that put data in and no others', () => {
    expect([...WRITE_OPERATIONS].sort()).toEqual([
      'CompleteMultipartUpload',
      'CreateMultipartUpload',
      'PutObject',
      'UploadPart',
    ]);
  });

  it('keeps its switches across a restart', async () => {
    const path = join(dir, 'switches.json');
    const first = createWriteKillSwitches({ path });
    first.setGlobal(true);
    first.setTenant('b', true);
    first.setTenant('a', true);
    first.setTenant('a', false);
    const second = createWriteKillSwitches({ path });
    expect(second.state()).toEqual({ global: true, tenants: ['b'] });
    expect(await readdir(dir)).toEqual(['switches.json']);
    expect(((await readFile(path, 'utf8')).match(/\n/g) ?? []).length).toBe(1);
  });

  it('starts with every switch off when there is no file yet', () => {
    expect(createWriteKillSwitches({ path: join(dir, 'none.json') }).state()).toEqual({
      global: false,
      tenants: [],
    });
  });

  it('refuses to start on a damaged file rather than switching writes back on', async () => {
    const path = join(dir, 'switches.json');
    for (const bad of [
      'not json',
      '{}',
      '{"global":"yes","tenants":[]}',
      '{"global":true,"tenants":[1]}',
      'null',
    ]) {
      await writeFile(path, bad);
      expect(() => createWriteKillSwitches({ path })).toThrow();
    }
  });

  it('refuses to start when the file cannot be read for another reason', async () => {
    expect(() => createWriteKillSwitches({ path: dir })).toThrow();
  });
});

describe('alert-only quotas', () => {
  function setup(limits = { requests: 10, billableBytesIn: 1000, billableBytesOut: 1000 }) {
    const used = new Map<string, QuotaUsage>();
    const alerts: QuotaAlert[] = [];
    const usage = (keyId: string): QuotaUsage =>
      used.get(keyId) ?? { requests: 0, billableBytesIn: 0, billableBytesOut: 0 };
    const monitor = createQuotaMonitor({
      usage: { totalFor: usage },
      alerts: { quotaCrossed: (a) => alerts.push(a) },
      default: limits,
      overrides: { special: { requests: 1 } },
    });
    return { used, alerts, monitor };
  }

  it('raises an alert once when a quota is crossed, and carries on', () => {
    const { used, alerts, monitor } = setup();
    used.set('a', { requests: 10, billableBytesIn: 0, billableBytesOut: 0 });
    monitor.observe('a');
    expect(alerts).toEqual([]);
    used.set('a', { requests: 11, billableBytesIn: 0, billableBytesOut: 0 });
    monitor.observe('a');
    monitor.observe('a');
    expect(alerts).toEqual([{ keyId: 'a', dimension: 'requests', limit: 10, used: 11 }]);
  });

  it('alerts for each dimension crossed and for each tenant separately', () => {
    const { used, alerts, monitor } = setup();
    used.set('a', { requests: 11, billableBytesIn: 2000, billableBytesOut: 5 });
    used.set('b', { requests: 0, billableBytesIn: 0, billableBytesOut: 1001 });
    monitor.observe('a');
    monitor.observe('b');
    expect(alerts.map((a) => `${a.keyId}:${a.dimension}`)).toEqual([
      'a:requests',
      'a:billableBytesIn',
      'b:billableBytesOut',
    ]);
  });

  it('alerts again after a reset, for the next period', () => {
    const { used, alerts, monitor } = setup();
    used.set('a', { requests: 11, billableBytesIn: 0, billableBytesOut: 0 });
    monitor.observe('a');
    monitor.reset('a');
    monitor.observe('a');
    expect(alerts).toHaveLength(2);
  });

  it('uses a tenant own quota when it has one, and ignores a dimension with no limit', () => {
    const { used, alerts, monitor } = setup({} as never);
    used.set('special', { requests: 2, billableBytesIn: 9e9, billableBytesOut: 9e9 });
    used.set('plain', { requests: 9e9, billableBytesIn: 9e9, billableBytesOut: 9e9 });
    monitor.observe('special');
    monitor.observe('plain');
    expect(alerts).toEqual([{ keyId: 'special', dimension: 'requests', limit: 1, used: 2 }]);
  });

  it('does nothing for a tenant with no quota at all', () => {
    const alerts: QuotaAlert[] = [];
    const monitor = createQuotaMonitor({
      usage: { totalFor: () => ({ requests: 9e9, billableBytesIn: 0, billableBytesOut: 0 }) },
      alerts: { quotaCrossed: (a) => alerts.push(a) },
    });
    monitor.observe('a');
    expect(alerts).toEqual([]);
  });

  it('refuses a quota that is negative or not a number', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createQuotaMonitor({
          usage: { totalFor: () => ({ requests: 0, billableBytesIn: 0, billableBytesOut: 0 }) },
          alerts: { quotaCrossed: () => undefined },
          default: { requests: bad },
        })
      ).toThrow(RangeError);
    }
  });
});

describe('the tenant limits gate', () => {
  function gate() {
    const c = clock();
    const switches = createWriteKillSwitches();
    const alerts: QuotaAlert[] = [];
    let used: QuotaUsage = { requests: 0, billableBytesIn: 0, billableBytesOut: 0 };
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({ default: { perSecond: 1, burst: 1000 }, nowMs: c.nowMs }),
      switches,
      quotas: createQuotaMonitor({
        usage: { totalFor: () => used },
        alerts: { quotaCrossed: (a) => alerts.push(a) },
        default: { requests: 5 },
      }),
    });
    return { limits, switches, alerts, setUsed: (u: QuotaUsage) => void (used = u), c };
  }

  it('refuses a tenant over its rate with a retryable answer while other tenants are served', () => {
    const c = clock();
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({ default: { perSecond: 1, burst: 2 }, nowMs: c.nowMs }),
      switches: createWriteKillSwitches(),
    });
    limits.check({ keyId: 'noisy', operation: 'GetObject' });
    limits.check({ keyId: 'noisy', operation: 'GetObject' });
    const refused = limits.check({ keyId: 'noisy', operation: 'GetObject' });
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: 'rate-limited', status: 503 },
      retryAfterMs: 1000,
    });
    expect(limits.check({ keyId: 'quiet', operation: 'PutObject' })).toEqual({ ok: true });
  });

  it('refuses a switched-off tenant writes but still serves its reads and aborts', () => {
    const { limits, switches } = gate();
    switches.setTenant('stopped', true);
    for (const operation of ALL) {
      const decision = limits.check({ keyId: 'stopped', operation });
      if (WRITE_OPERATIONS.has(operation)) {
        expect(decision).toMatchObject({ ok: false, refusal: { code: 'writes-disabled' } });
      } else {
        expect(decision).toEqual({ ok: true });
      }
    }
  });

  it('lets another tenant write while one tenant is switched off', () => {
    const { limits, switches } = gate();
    switches.setTenant('stopped', true);
    expect(limits.check({ keyId: 'healthy', operation: 'PutObject' })).toEqual({ ok: true });
    expect(limits.check({ keyId: 'healthy', operation: 'CompleteMultipartUpload' })).toEqual({
      ok: true,
    });
  });

  it('refuses every tenant writes under the global switch and serves their reads', () => {
    const { limits, switches } = gate();
    switches.setGlobal(true);
    for (const keyId of ['a', 'b']) {
      expect(limits.check({ keyId, operation: 'PutObject' })).toMatchObject({ ok: false });
      expect(limits.check({ keyId, operation: 'GetObject' })).toEqual({ ok: true });
      expect(limits.check({ keyId, operation: 'HeadObject' })).toEqual({ ok: true });
    }
  });

  it('does not spend rate allowance on a write the switch refuses', () => {
    const c = clock();
    const switches = createWriteKillSwitches();
    switches.setGlobal(true);
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({ default: { perSecond: 0.001, burst: 1 }, nowMs: c.nowMs }),
      switches,
    });
    for (let i = 0; i < 5; i += 1) limits.check({ keyId: 'a', operation: 'PutObject' });
    expect(limits.check({ keyId: 'a', operation: 'GetObject' })).toEqual({ ok: true });
  });

  it('lets a quota store error out of the gate rather than swallowing it', () => {
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({ default: { perSecond: 1, burst: 10 } }),
      switches: createWriteKillSwitches(),
      quotas: createQuotaMonitor({
        usage: {
          totalFor: () => {
            throw new Error('usage store down');
          },
        },
        alerts: { quotaCrossed: () => undefined },
        default: { requests: 5 },
      }),
    });
    expect(() => limits.check({ keyId: 'k', operation: 'GetObject' })).toThrow('usage store down');
  });

  it('raises an alert on crossing a quota and refuses nothing', () => {
    const { limits, alerts, setUsed } = gate();
    setUsed({ requests: 6, billableBytesIn: 0, billableBytesOut: 0 });
    for (const operation of ALL) {
      expect(limits.check({ keyId: 'a', operation })).toEqual({ ok: true });
    }
    expect(alerts).toEqual([{ keyId: 'a', dimension: 'requests', limit: 5, used: 6 }]);
  });
});

describe('admit with limits', () => {
  const BUCKET = 'shard-one-bucket';
  const FOLDER = 'k7f3q9x2m1';
  const record: CredentialRecord = {
    folder: FOLDER,
    bucket: BUCKET,
    state: 'active',
    createdAt: '2026-10-06T00:00:00Z',
  };
  const request = (method: string, name: string): GatewayRequest => ({
    method,
    rawTarget: `/${BUCKET}/${FOLDER}/${name}`,
    headers: {},
  });

  function setup(limits: TenantLimits | undefined, keyId = 'tenant-key-1') {
    const logged: RefusalLogEntry[] = [];
    const credentials: CredentialStore = { lookup: async () => record };
    const verifier: SignatureVerifier = { verify: async () => ({ ok: true, keyId }) };
    return {
      logged,
      deps: {
        verifier,
        credentials,
        logger: { refusal: (e: RefusalLogEntry) => logged.push(e) },
        ...(limits === undefined ? {} : { limits }),
      },
    };
  }

  it('refuses a write under a kill switch, logs it with the tenant, and still admits a read', async () => {
    const switches = createWriteKillSwitches();
    switches.setTenant('tenant-key-1', true);
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({ default: { perSecond: 100, burst: 100 } }),
      switches,
    });
    const { deps, logged } = setup(limits);
    const write = await admit(request('PUT', 'a.png'), deps);
    expect(write).toMatchObject({ ok: false, refusal: { code: 'writes-disabled' } });
    expect(logged).toEqual([
      expect.objectContaining({
        code: 'writes-disabled',
        keyId: 'tenant-key-1',
        folder: FOLDER,
        operation: 'PutObject',
      }),
    ]);
    expect(await admit(request('GET', 'a.png'), deps)).toMatchObject({ ok: true });
  });

  it('refuses a tenant over its rate, and not another tenant', async () => {
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({ default: { perSecond: 0.001, burst: 1 } }),
      switches: createWriteKillSwitches(),
    });
    const noisy = setup(limits, 'noisy-key');
    const quiet = setup(limits, 'quiet-key');
    expect(await admit(request('GET', 'a.png'), noisy.deps)).toMatchObject({ ok: true });
    expect(await admit(request('GET', 'a.png'), noisy.deps)).toMatchObject({
      ok: false,
      refusal: { code: 'rate-limited' },
    });
    expect(await admit(request('GET', 'a.png'), quiet.deps)).toMatchObject({ ok: true });
  });

  it('does not spend allowance on a request the folder guard refuses', async () => {
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({ default: { perSecond: 0.001, burst: 1 } }),
      switches: createWriteKillSwitches(),
    });
    const { deps } = setup(limits);
    const outside: GatewayRequest = {
      method: 'GET',
      rawTarget: `/${BUCKET}/other0000/a.png`,
      headers: {},
    };
    await admit(outside, deps);
    await admit(outside, deps);
    expect(await admit(request('GET', 'a.png'), deps)).toMatchObject({ ok: true });
  });

  it('fails closed when the limits gate throws', async () => {
    const limits: TenantLimits = {
      check: () => {
        throw new Error('boom');
      },
    };
    const { deps, logged } = setup(limits);
    expect(await admit(request('GET', 'a.png'), deps)).toMatchObject({
      ok: false,
      refusal: { code: 'internal-error' },
    });
    expect(logged).toHaveLength(1);
  });

  it('refuses with internal-error when the quota store errors (fails closed)', async () => {
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({ default: { perSecond: 100, burst: 100 } }),
      switches: createWriteKillSwitches(),
      quotas: createQuotaMonitor({
        usage: {
          totalFor: () => {
            throw new Error('usage store down');
          },
        },
        alerts: { quotaCrossed: () => undefined },
        default: { requests: 5 },
      }),
    });
    const { deps, logged } = setup(limits);
    expect(await admit(request('GET', 'a.png'), deps)).toMatchObject({
      ok: false,
      refusal: { code: 'internal-error' },
    });
    expect(logged).toHaveLength(1);
  });

  it('carries the retry hint of a rate-limited refusal to the caller', async () => {
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({
        default: { perSecond: 1, burst: 1 },
        nowMs: () => 1_000_000,
      }),
      switches: createWriteKillSwitches(),
    });
    const { deps } = setup(limits);
    await admit(request('GET', 'a.png'), deps);
    expect(await admit(request('GET', 'a.png'), deps)).toMatchObject({
      ok: false,
      refusal: { code: 'rate-limited' },
      retryAfterMs: 1000,
    });
  });

  it('gives no retry hint on a refusal that is not rate-limiting', async () => {
    const switches = createWriteKillSwitches();
    switches.setGlobal(true);
    const limits = createTenantLimits({
      rate: createTenantRateLimiter({ default: { perSecond: 1, burst: 1 } }),
      switches,
    });
    const { deps } = setup(limits);
    const result = await admit(request('PUT', 'a.png'), deps);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'writes-disabled' } });
    expect(result).not.toHaveProperty('retryAfterMs');
  });

  it('admits as before when no limits are given', async () => {
    const { deps } = setup(undefined);
    expect(await admit(request('PUT', 'a.png'), deps)).toMatchObject({ ok: true });
  });
});
