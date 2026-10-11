import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import {
  FakeWrappedAdapter,
  makeLoadWrappedAdapterClass,
} from '../helpers/fake-wrapped-adapter.mjs';

const require = createRequire(import.meta.url);
const metricsModulePath = require.resolve('../../src/metrics.js');
const {
  ScannerMetrics,
  writeTextfileAtomic,
  startTextfileExport,
  MISCONFIGURED_TOKEN,
} = require('../../src/metrics.js');
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { FakeVerdictClient, UnconfiguredVerdictClient } = require('../../src/verdict-client.js');
const { SafetyPolicy } = require('../../src/policy.js');
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { digestBytes } = require('../../src/pdq.js');
const GhostErrors = require('@tryghost/errors');

const CLEAN_BYTES = Buffer.from('clean-image-bytes');
const BAD_BYTES = Buffer.from('known-bad-image-bytes');
const BAD_DIGEST = digestBytes(BAD_BYTES);
const SILENT_LOGGER = { error: () => {} };
const RETRY_MS = 20;
const WAIT = { timeout: 3000, interval: 10 };

// Reads one series' value out of exposition text; throws when it is absent,
// so a renamed series fails a test loudly rather than reading as zero.
function valueOf(text, name, labels = {}) {
  const wanted = Object.entries(labels).map(([key, value]) => `${key}="${value}"`);
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    const match = line.match(/^([a-z_]+)(\{[^}]*\})? (\S+)$/);
    if (!match || match[1] !== name) continue;
    const present = match[2] ?? '';
    if (wanted.every((label) => present.includes(label))) return Number(match[3]);
  }
  throw new Error(`series not found: ${name} ${JSON.stringify(labels)}`);
}

let tmpDir;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanning-metrics-test-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('ScannerMetrics exposition', () => {
  it('renders every series at zero before anything happens, so a first increment is visible', () => {
    const text = new ScannerMetrics({ tenant: 'acme', now: () => 5000 }).render();
    expect(valueOf(text, 'scanning_storage_unconfigured_instances', { tenant: 'acme' })).toBe(0);
    for (const reason of ['unconfigured', 'verdict', 'sealed']) {
      expect(valueOf(text, 'scanning_storage_uploads_refused_total', { reason })).toBe(0);
    }
    for (const classification of ['csam', 'no-known-match', 'unavailable', 'other']) {
      expect(valueOf(text, 'scanning_storage_verdicts_total', { classification })).toBe(0);
    }
    for (const kind of ['timeout', 'error']) {
      expect(valueOf(text, 'scanning_storage_verdict_errors_total', { kind })).toBe(0);
    }
    expect(valueOf(text, 'scanning_storage_held_uploads')).toBe(0);
    expect(valueOf(text, 'scanning_storage_held_oldest_age_seconds')).toBe(0);
    expect(valueOf(text, 'scanning_storage_held_stuck')).toBe(0);
    expect(valueOf(text, 'scanning_storage_metrics_written_timestamp_seconds')).toBe(5);
    expect(text).toMatch(/# TYPE scanning_storage_verdict_duration_seconds histogram/);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('counts refusals by reason and ignores a reason outside the vocabulary', () => {
    const metrics = new ScannerMetrics();
    metrics.recordRefusal('unconfigured');
    metrics.recordRefusal('unconfigured');
    metrics.recordRefusal('verdict');
    metrics.recordRefusal('not-a-reason');
    const text = metrics.render();
    expect(
      valueOf(text, 'scanning_storage_uploads_refused_total', { reason: 'unconfigured' })
    ).toBe(2);
    expect(valueOf(text, 'scanning_storage_uploads_refused_total', { reason: 'verdict' })).toBe(1);
    expect(valueOf(text, 'scanning_storage_uploads_refused_total', { reason: 'sealed' })).toBe(0);
    expect(text).not.toContain('not-a-reason');
  });

  it('keeps the classification label bounded: an unknown classification counts as other', () => {
    const metrics = new ScannerMetrics();
    metrics.recordVerdict('csam');
    metrics.recordVerdict('something-a-future-source-invents');
    const text = metrics.render();
    expect(valueOf(text, 'scanning_storage_verdicts_total', { classification: 'csam' })).toBe(1);
    expect(valueOf(text, 'scanning_storage_verdicts_total', { classification: 'other' })).toBe(1);
    expect(text).not.toContain('future-source');
  });

  it('counts verdict errors by kind', () => {
    const metrics = new ScannerMetrics();
    metrics.recordVerdictError('timeout');
    metrics.recordVerdictError('error');
    metrics.recordVerdictError('error');
    metrics.recordVerdictError('other');
    const text = metrics.render();
    expect(valueOf(text, 'scanning_storage_verdict_errors_total', { kind: 'timeout' })).toBe(1);
    expect(valueOf(text, 'scanning_storage_verdict_errors_total', { kind: 'error' })).toBe(2);
  });

  it('renders the latency histogram cumulatively, with +Inf equal to the count', () => {
    const metrics = new ScannerMetrics();
    metrics.observeVerdictSeconds(0.04);
    metrics.observeVerdictSeconds(0.3);
    metrics.observeVerdictSeconds(9);
    metrics.observeVerdictSeconds(-1);
    metrics.observeVerdictSeconds(Number.NaN);
    const text = metrics.render();
    const bucket = (le) =>
      valueOf(text, 'scanning_storage_verdict_duration_seconds_bucket', { le });
    expect(bucket('0.05')).toBe(1);
    expect(bucket('0.5')).toBe(2);
    expect(bucket('5')).toBe(2);
    expect(bucket('+Inf')).toBe(3);
    expect(valueOf(text, 'scanning_storage_verdict_duration_seconds_count')).toBe(3);
    expect(valueOf(text, 'scanning_storage_verdict_duration_seconds_sum')).toBeCloseTo(9.34, 5);
  });

  it('sums held sources, takes the oldest start, and skips a source that throws', () => {
    const metrics = new ScannerMetrics({ now: () => 100_000 });
    metrics.addHeldSource(() => ({ count: 2, oldestSinceMs: 70_000, stuck: 1 }));
    metrics.addHeldSource(() => ({ count: 1, oldestSinceMs: 90_000, stuck: 0 }));
    metrics.addHeldSource(() => ({ count: 0, oldestSinceMs: null, stuck: 0 }));
    metrics.addHeldSource(() => {
      throw new Error('unreadable');
    });
    metrics.addHeldSource('not a function');
    const text = metrics.render();
    expect(valueOf(text, 'scanning_storage_held_uploads')).toBe(3);
    expect(valueOf(text, 'scanning_storage_held_oldest_age_seconds')).toBe(30);
    expect(valueOf(text, 'scanning_storage_held_stuck')).toBe(1);
  });

  it('escapes a label value and omits the tenant label when none is set', () => {
    const quoted = new ScannerMetrics({ tenant: 'a"b\\c\nd' }).render();
    expect(quoted).toContain('tenant="a\\"b\\\\c\\nd"');
    const bare = new ScannerMetrics().render();
    expect(bare).toContain('scanning_storage_held_uploads 0');
  });

  it('never throws from a record method', () => {
    const metrics = new ScannerMetrics();
    metrics.refused = null;
    metrics.verdicts = null;
    metrics.errors = null;
    metrics.latencyBuckets = null;
    metrics.unconfiguredInstances = {
      valueOf: () => {
        throw new Error('boom');
      },
    };
    expect(() => {
      metrics.recordRefusal('verdict');
      metrics.recordVerdict('csam');
      metrics.recordVerdictError('error');
      metrics.observeVerdictSeconds(1);
      metrics.recordUnconfiguredInstance();
    }).not.toThrow();
  });
});

describe('the textfile export', () => {
  it('writes atomically and leaves no temporary file behind', () => {
    const file = path.join(tmpDir, 'nested', 'scanner.prom');
    writeTextfileAtomic(file, 'a 1\n');
    expect(fsSync.readFileSync(file, 'utf8')).toBe('a 1\n');
    expect(fsSync.readdirSync(path.dirname(file))).toEqual(['scanner.prom']);
  });

  it('writes at once, then on every interval, and stops when told to', () => {
    vi.useFakeTimers();
    const file = path.join(tmpDir, 'scanner.prom');
    const metrics = new ScannerMetrics({ tenant: 'acme' });
    const stop = startTextfileExport(metrics, { filePath: file, intervalMs: 1000 });
    expect(
      valueOf(fsSync.readFileSync(file, 'utf8'), 'scanning_storage_uploads_refused_total', {
        reason: 'verdict',
      })
    ).toBe(0);
    metrics.recordRefusal('verdict');
    vi.advanceTimersByTime(1000);
    expect(
      valueOf(fsSync.readFileSync(file, 'utf8'), 'scanning_storage_uploads_refused_total', {
        reason: 'verdict',
      })
    ).toBe(1);
    stop();
    metrics.recordRefusal('verdict');
    vi.advanceTimersByTime(5000);
    expect(
      valueOf(fsSync.readFileSync(file, 'utf8'), 'scanning_storage_uploads_refused_total', {
        reason: 'verdict',
      })
    ).toBe(1);
  });

  it('logs a failing write once, keeps going, and logs again after a recovery', () => {
    vi.useFakeTimers();
    const blocker = path.join(tmpDir, 'blocker');
    fsSync.writeFileSync(blocker, 'a file where a directory is needed');
    const file = path.join(blocker, 'scanner.prom');
    const logged = [];
    const stop = startTextfileExport(new ScannerMetrics(), {
      filePath: file,
      intervalMs: 1000,
      logger: { error: (...args) => logged.push(args[0]) },
    });
    vi.advanceTimersByTime(3000);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('could not write the metrics textfile');
    fsSync.rmSync(blocker);
    vi.advanceTimersByTime(1000);
    expect(fsSync.existsSync(file)).toBe(true);
    fsSync.rmSync(file);
    fsSync.mkdirSync(file);
    vi.advanceTimersByTime(1000);
    expect(logged).toHaveLength(2);
    stop();
  });
});

describe('configureProcessExport', () => {
  // The module keeps process-wide state; each case loads it afresh.
  function freshModule() {
    delete require.cache[metricsModulePath];
    return require('../../src/metrics.js');
  }

  it('exports nothing and says nothing when neither key is set', () => {
    const mod = freshModule();
    const logged = [];
    expect(mod.configureProcessExport({}, { error: (m) => logged.push(m) })).toBe(false);
    expect(logged).toEqual([]);
  });

  it.each([
    ['a path with no tenant', { metricsTextfilePath: '/tmp/x/scanner.prom' }],
    ['a tenant with no path', { metricsTenant: 'acme' }],
    ['a relative path', { metricsTextfilePath: 'scanner.prom', metricsTenant: 'acme' }],
    [
      'a path not ending in .prom',
      { metricsTextfilePath: '/tmp/x/scanner.txt', metricsTenant: 'acme' },
    ],
  ])('refuses %s, naming a greppable token, and exports nothing', (_label, config) => {
    const mod = freshModule();
    const logged = [];
    expect(mod.configureProcessExport(config, { error: (m) => logged.push(m) })).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(MISCONFIGURED_TOKEN);
  });

  it('starts one export, sets the tenant, and ignores a second path with a log line', () => {
    const mod = freshModule();
    const metrics = new mod.ScannerMetrics();
    const first = path.join(tmpDir, 'one.prom');
    const logged = [];
    const logger = { error: (m) => logged.push(m) };
    vi.useFakeTimers();
    expect(
      mod.configureProcessExport(
        { metricsTextfilePath: first, metricsTenant: 'acme' },
        logger,
        metrics
      )
    ).toBe(true);
    expect(metrics.tenant).toBe('acme');
    expect(fsSync.readFileSync(first, 'utf8')).toContain('tenant="acme"');
    expect(
      mod.configureProcessExport(
        { metricsTextfilePath: first, metricsTenant: 'acme' },
        logger,
        metrics
      )
    ).toBe(false);
    expect(logged).toEqual([]);
    const second = path.join(tmpDir, 'two.prom');
    expect(
      mod.configureProcessExport(
        { metricsTextfilePath: second, metricsTenant: 'acme' },
        logger,
        metrics
      )
    ).toBe(false);
    expect(logged).toHaveLength(1);
    expect(fsSync.existsSync(second)).toBe(false);
  });

  it('hands out one registry per process', () => {
    const mod = freshModule();
    expect(mod.getProcessMetrics()).toBe(mod.getProcessMetrics());
  });
});

describe('the check reports what it sees', () => {
  const computeDigest = (buffer) => buffer.toString('hex');

  it('counts a clean verdict and observes its latency', async () => {
    let clock = 1000;
    const metrics = new ScannerMetrics();
    const client = {
      async getVerdict(digest) {
        clock += 250;
        return { classification: 'no-known-match', source: 's', evidence: digest };
      },
    };
    const check = createPdqKnownMaterialCheck(client, { computeDigest, metrics, now: () => clock });
    await check.run({ buffer: Buffer.from('x') });
    const text = metrics.render();
    expect(
      valueOf(text, 'scanning_storage_verdicts_total', { classification: 'no-known-match' })
    ).toBe(1);
    expect(valueOf(text, 'scanning_storage_verdict_duration_seconds_count')).toBe(1);
    expect(valueOf(text, 'scanning_storage_verdict_duration_seconds_sum')).toBe(0.25);
    expect(valueOf(text, 'scanning_storage_verdict_errors_total', { kind: 'timeout' })).toBe(0);
    expect(valueOf(text, 'scanning_storage_verdict_errors_total', { kind: 'error' })).toBe(0);
  });

  it('counts a timeout as an error of kind timeout and an unavailable verdict', async () => {
    const metrics = new ScannerMetrics();
    const client = { getVerdict: () => new Promise(() => {}) };
    const check = createPdqKnownMaterialCheck(client, { computeDigest, metrics, timeoutMs: 20 });
    const verdict = await check.run({ buffer: Buffer.from('x') });
    expect(verdict).toMatchObject({ classification: 'unavailable', source: 'timeout' });
    const text = metrics.render();
    expect(valueOf(text, 'scanning_storage_verdict_errors_total', { kind: 'timeout' })).toBe(1);
    expect(
      valueOf(text, 'scanning_storage_verdicts_total', { classification: 'unavailable' })
    ).toBe(1);
  });

  it('counts a throwing channel as an error of kind error', async () => {
    const metrics = new ScannerMetrics();
    const client = {
      async getVerdict() {
        throw new Error('channel unreachable');
      },
    };
    const check = createPdqKnownMaterialCheck(client, { computeDigest, metrics });
    await check.run({ buffer: Buffer.from('x') });
    const text = metrics.render();
    expect(valueOf(text, 'scanning_storage_verdict_errors_total', { kind: 'error' })).toBe(1);
    expect(valueOf(text, 'scanning_storage_verdict_errors_total', { kind: 'timeout' })).toBe(0);
  });
});

describe('the decorator reports through an injected registry', () => {
  function build({ client, metrics, refuseUploadsReason = null, quarantinePath, timeoutMs }) {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    return new Adapter({
      wraps: 'FakeAdapter',
      wrappedConfig: { storagePath: 'wrapped' },
      quarantinePath: quarantinePath ?? path.join(tmpDir, 'quarantine'),
      checks: [
        createPdqKnownMaterialCheck(client, { computeDigest: digestBytes, metrics, timeoutMs }),
      ],
      policy: new SafetyPolicy(),
      computeDigest: digestBytes,
      holdRetryMs: RETRY_MS,
      holdMaxRetryMs: RETRY_MS,
      holdLogger: SILENT_LOGGER,
      refuseUploadsReason,
      metrics,
    });
  }

  it('control: an adapter with no verdict source counts its refusals and its own state', async () => {
    const metrics = new ScannerMetrics();
    const adapter = build({
      client: new UnconfiguredVerdictClient(),
      metrics,
      refuseUploadsReason: 'SCANNER_UNCONFIGURED',
    });
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/a.png')).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/b.png')).rejects.toMatchObject({
      statusCode: 503,
    });
    const text = metrics.render();
    expect(
      valueOf(text, 'scanning_storage_uploads_refused_total', { reason: 'unconfigured' })
    ).toBe(2);
    expect(valueOf(text, 'scanning_storage_unconfigured_instances')).toBe(1);
    expect(
      valueOf(text, 'scanning_storage_verdicts_total', { classification: 'unavailable' })
    ).toBe(0);
  });

  it('control: an adapter with a source and a clean upload records no refusal', async () => {
    const metrics = new ScannerMetrics();
    const adapter = build({ client: new FakeVerdictClient(), metrics });
    await adapter.saveRaw(CLEAN_BYTES, '2026/10/a.png');
    const text = metrics.render();
    for (const reason of ['unconfigured', 'verdict', 'sealed']) {
      expect(valueOf(text, 'scanning_storage_uploads_refused_total', { reason })).toBe(0);
    }
    expect(valueOf(text, 'scanning_storage_unconfigured_instances')).toBe(0);
    expect(
      valueOf(text, 'scanning_storage_verdicts_total', { classification: 'no-known-match' })
    ).toBe(1);
  });

  it('counts a known match as a verdict refusal and its repeat as a sealed one', async () => {
    const metrics = new ScannerMetrics();
    const client = new FakeVerdictClient({
      refuse: new Map([[BAD_DIGEST, { classification: 'csam', matchType: 'exact' }]]),
    });
    const adapter = build({ client, metrics });
    await expect(adapter.saveRaw(BAD_BYTES, '2026/10/bad.png')).rejects.toMatchObject({
      statusCode: 415,
    });
    await expect(adapter.saveRaw(BAD_BYTES, '2026/10/bad2.png')).rejects.toMatchObject({
      statusCode: 415,
    });
    const text = metrics.render();
    expect(valueOf(text, 'scanning_storage_uploads_refused_total', { reason: 'verdict' })).toBe(1);
    expect(valueOf(text, 'scanning_storage_uploads_refused_total', { reason: 'sealed' })).toBe(1);
    expect(valueOf(text, 'scanning_storage_verdicts_total', { classification: 'csam' })).toBe(1);
  });

  it('control: a channel that times out raises the error and held-age series, and restoring it clears them', async () => {
    const metrics = new ScannerMetrics({ now: () => Date.now() + 60_000 });
    let answer = null;
    const client = {
      getVerdict(digest) {
        if (answer) return Promise.resolve({ ...answer, source: 'test', evidence: digest });
        return new Promise(() => {});
      },
    };
    const adapter = build({ client, metrics, timeoutMs: 20 });
    await adapter.saveRaw(CLEAN_BYTES, '2026/10/held.png');
    await vi.waitFor(() => {
      const text = metrics.render();
      expect(
        valueOf(text, 'scanning_storage_verdict_errors_total', { kind: 'timeout' })
      ).toBeGreaterThan(0);
    }, WAIT);
    const during = metrics.render();
    expect(valueOf(during, 'scanning_storage_held_uploads')).toBe(1);
    expect(valueOf(during, 'scanning_storage_held_oldest_age_seconds')).toBeGreaterThanOrEqual(59);
    answer = { classification: 'no-known-match' };
    await vi.waitFor(() => {
      expect(valueOf(metrics.render(), 'scanning_storage_held_uploads')).toBe(0);
    }, WAIT);
    expect(valueOf(metrics.render(), 'scanning_storage_held_oldest_age_seconds')).toBe(0);
    adapter.hold.stopAll();
  });

  it('counts a hold left stuck, and no longer counts it as waiting', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const never = { getVerdict: () => new Promise(() => {}) };
    const first = build({
      client: never,
      metrics: new ScannerMetrics(),
      quarantinePath,
      timeoutMs: 20,
    });
    await first.saveRaw(CLEAN_BYTES, '2026/10/held.png');
    first.hold.stopAll();
    const sidecarName = fsSync
      .readdirSync(quarantinePath)
      .find((name) => name.endsWith('.holds.json'));
    const sidecarFile = path.join(quarantinePath, sidecarName);
    const sidecar = JSON.parse(fsSync.readFileSync(sidecarFile, 'utf8'));
    const owner = Object.keys(sidecar.owners)[0];
    sidecar.stuck = { [owner]: { reason: 'test: gave up' } };
    fsSync.writeFileSync(sidecarFile, JSON.stringify(sidecar));

    const metrics = new ScannerMetrics();
    const second = build({ client: never, metrics, quarantinePath, timeoutMs: 20 });
    const text = metrics.render();
    expect(valueOf(text, 'scanning_storage_held_stuck')).toBe(1);
    expect(valueOf(text, 'scanning_storage_held_uploads')).toBe(0);
    second.hold.stopAll();
  });

  it('dates a resumed hold from its quarantined bytes', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const never = { getVerdict: () => new Promise(() => {}) };
    const first = build({
      client: never,
      metrics: new ScannerMetrics(),
      quarantinePath,
      timeoutMs: 20,
    });
    await first.saveRaw(CLEAN_BYTES, '2026/10/held.png');
    first.hold.stopAll();
    const digest = digestBytes(CLEAN_BYTES);
    const anHourAgo = new Date(Date.now() - 3_600_000);
    fsSync.utimesSync(path.join(quarantinePath, digest), anHourAgo, anHourAgo);

    const metrics = new ScannerMetrics();
    const second = build({ client: never, metrics, quarantinePath, timeoutMs: 20 });
    const summary = second.hold.heldSummary();
    expect(summary.count).toBe(1);
    expect(summary.stuck).toBe(0);
    expect(Date.now() - summary.oldestSinceMs).toBeGreaterThanOrEqual(3_599_000);
    expect(
      valueOf(metrics.render(), 'scanning_storage_held_oldest_age_seconds')
    ).toBeGreaterThanOrEqual(3599);
    second.hold.stopAll();
  });

  it('dates a resumed hold from now when its bytes cannot be statted', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const never = { getVerdict: () => new Promise(() => {}) };
    const first = build({
      client: never,
      metrics: new ScannerMetrics(),
      quarantinePath,
      timeoutMs: 20,
    });
    await first.saveRaw(CLEAN_BYTES, '2026/10/held.png');
    first.hold.stopAll();
    const spy = vi.spyOn(fsSync, 'statSync').mockImplementation(() => {
      throw new Error('stat failed');
    });
    const before = Date.now();
    const second = build({
      client: never,
      metrics: new ScannerMetrics(),
      quarantinePath,
      timeoutMs: 20,
    });
    spy.mockRestore();
    expect(second.hold.heldSummary().count).toBe(1);
    expect(second.hold.heldSummary().oldestSinceMs).toBeGreaterThanOrEqual(before);
    second.hold.stopAll();
  });
});
