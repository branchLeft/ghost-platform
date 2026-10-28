import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AllowedOperation } from '../src/contracts.js';
import type { RoutedRequest } from '../src/router.js';
import { BILLABLE_UNIT_BYTES, billableBytes } from '../src/usage/billing.js';
import { SqliteWriteLedger } from '../src/usage/ledger.js';
import { UsageMeter, renderUsageMetrics, type UsageSink } from '../src/usage/meter.js';
import { UsageRecorder, type CallOutcome, type UsageTenant } from '../src/usage/recorder.js';

const UNIT = BILLABLE_UNIT_BYTES;
const BUCKET = 'media-shard-a';
const TENANT_A: UsageTenant = { keyId: 'key-a', folder: 'folderaaaa1', bucket: BUCKET };
const TENANT_B: UsageTenant = { keyId: 'key-b', folder: 'folderbbbb2', bucket: BUCKET };
const AT = '2026-10-06T09:30:15.000Z';

let dir: string;
let dbPath: string;
let ledger: SqliteWriteLedger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gateway-ledger-test-'));
  dbPath = join(dir, 'ledger.sqlite');
  ledger = SqliteWriteLedger.open(dbPath);
});

afterEach(async () => {
  try {
    ledger.close();
  } catch {
    // already closed by the test
  }
  await rm(dir, { recursive: true, force: true });
});

const route = (
  operation: AllowedOperation,
  tenant: UsageTenant,
  name: string,
  extra: Partial<RoutedRequest> = {}
): RoutedRequest => ({
  operation,
  bucket: tenant.bucket,
  key: `${tenant.folder}/${name}`,
  ...extra,
});

interface Step {
  readonly tenant: UsageTenant;
  readonly route: RoutedRequest;
  readonly bodySize?: number;
  readonly status: number;
  readonly responseBytes?: number;
}

function run(recorder: UsageRecorder, steps: readonly Step[]): void {
  for (const step of steps) {
    const call: CallOutcome = {
      tenant: step.tenant,
      route: step.route,
      bodySize: step.bodySize ?? 0,
      status: step.status,
      responseBytes: step.responseBytes ?? 0,
    };
    recorder.beforeUpstream(call);
    recorder.afterUpstream(call);
  }
}

const MIB5 = 5 * 1024 * 1024;

/** A scripted run of known uploads, reads and failures across two tenants. */
const SCRIPT: Step[] = [
  { tenant: TENANT_A, route: route('PutObject', TENANT_A, 'a.png'), bodySize: 100, status: 200 },
  { tenant: TENANT_A, route: route('PutObject', TENANT_A, 'b.png'), bodySize: UNIT, status: 200 },
  {
    tenant: TENANT_A,
    route: route('PutObject', TENANT_A, 'c.png'),
    bodySize: UNIT + 1,
    status: 200,
  },
  { tenant: TENANT_A, route: route('PutObject', TENANT_A, 'd.png'), bodySize: 100, status: 403 },
  { tenant: TENANT_A, route: route('PutObject', TENANT_A, 'e.png'), bodySize: 100, status: 504 },
  { tenant: TENANT_A, route: route('CreateMultipartUpload', TENANT_A, 'big.bin'), status: 200 },
  {
    tenant: TENANT_A,
    route: route('UploadPart', TENANT_A, 'big.bin', { uploadId: 'u1', partNumber: 1 }),
    bodySize: MIB5,
    status: 200,
  },
  {
    tenant: TENANT_A,
    route: route('UploadPart', TENANT_A, 'big.bin', { uploadId: 'u1', partNumber: 2 }),
    bodySize: 100,
    status: 200,
  },
  {
    tenant: TENANT_A,
    route: route('CompleteMultipartUpload', TENANT_A, 'big.bin', { uploadId: 'u1' }),
    bodySize: 400,
    status: 200,
    responseBytes: 300,
  },
  {
    tenant: TENANT_A,
    route: route('UploadPart', TENANT_A, 'dropped.bin', { uploadId: 'u2', partNumber: 1 }),
    bodySize: 100,
    status: 200,
  },
  {
    tenant: TENANT_A,
    route: route('AbortMultipartUpload', TENANT_A, 'dropped.bin', { uploadId: 'u2' }),
    status: 204,
  },
  {
    tenant: TENANT_A,
    route: route('GetObject', TENANT_A, 'a.png'),
    status: 200,
    responseBytes: 70_000,
  },
  { tenant: TENANT_A, route: route('HeadObject', TENANT_A, 'a.png'), status: 200 },
  { tenant: TENANT_B, route: route('PutObject', TENANT_B, 'z.png'), bodySize: 10, status: 200 },
];

const row = (
  keyId: string,
  operation: string,
  requests: number,
  billableBytesIn: number,
  billableBytesOut: number
) => ({ keyId, operation, requests, billableBytesIn, billableBytesOut });

const EXPECTED_USAGE = [
  row('key-a', 'AbortMultipartUpload', 1, 0, 0),
  row('key-a', 'CompleteMultipartUpload', 1, UNIT, UNIT),
  row('key-a', 'CreateMultipartUpload', 1, 0, 0),
  row('key-a', 'GetObject', 1, 0, 2 * UNIT),
  row('key-a', 'HeadObject', 1, 0, 0),
  row('key-a', 'PutObject', 5, 4 * UNIT, 0),
  row('key-a', 'UploadPart', 3, MIB5 + 2 * UNIT, 0),
  row('key-b', 'PutObject', 1, UNIT, 0),
];

describe('billableBytes', () => {
  it('rounds up to whole 64 KiB units and bills nothing for nothing', () => {
    expect(UNIT).toBe(65_536);
    expect(billableBytes(0)).toBe(0);
    expect(billableBytes(1)).toBe(UNIT);
    expect(billableBytes(UNIT)).toBe(UNIT);
    expect(billableBytes(UNIT + 1)).toBe(2 * UNIT);
    expect(billableBytes(5 * 1024 * 1024)).toBe(5 * 1024 * 1024);
  });

  it('rejects a count that is not a non-negative whole number', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => billableBytes(bad)).toThrow(RangeError);
    }
  });
});

describe('usage counting', () => {
  it('matches a scripted run of known requests exactly', () => {
    const meter = new UsageMeter();
    run(new UsageRecorder({ ledger, meter, now: () => AT }), SCRIPT);
    expect(meter.snapshot()).toEqual(EXPECTED_USAGE);
    expect(meter.totalFor('key-a')).toEqual({
      requests: 13,
      billableBytesIn: 4 * UNIT + MIB5 + 2 * UNIT + UNIT,
      billableBytesOut: 3 * UNIT,
    });
    expect(meter.totalFor('nobody')).toEqual({
      requests: 0,
      billableBytesIn: 0,
      billableBytesOut: 0,
    });
  });

  it('counts a refused or failed request but bills no bytes for it', () => {
    const meter = new UsageMeter();
    run(new UsageRecorder({ ledger, meter, now: () => AT }), [
      {
        tenant: TENANT_A,
        route: route('PutObject', TENANT_A, 'x.png'),
        bodySize: 9 * UNIT,
        status: 413,
        responseBytes: 200,
      },
    ]);
    expect(meter.snapshot()).toEqual([row('key-a', 'PutObject', 1, 0, 0)]);
  });

  it('saves counts in batches and loses none across a restart', () => {
    const meter = new UsageMeter();
    const recorder = new UsageRecorder({ ledger, meter, now: () => AT });
    run(recorder, SCRIPT.slice(0, 7));
    meter.flush(ledger);
    run(recorder, SCRIPT.slice(7));
    meter.flush(ledger);
    meter.flush(ledger);
    ledger.close();

    const reopened = SqliteWriteLedger.open(dbPath);
    const restored = new UsageMeter(reopened.loadUsage());
    expect(restored.snapshot()).toEqual(EXPECTED_USAGE);
    const again = new UsageRecorder({ ledger: reopened, meter: restored, now: () => AT });
    run(again, [SCRIPT[0] as Step]);
    restored.flush(reopened);
    expect(new UsageMeter(reopened.loadUsage()).totalFor('key-a').requests).toBe(14);
    ledger = reopened;
  });

  it('keeps unsaved counts when the save fails and saves them once on the next try', () => {
    const meter = new UsageMeter();
    run(new UsageRecorder({ ledger, meter, now: () => AT }), SCRIPT.slice(0, 2));
    let fail = true;
    const sink: UsageSink = {
      addUsage: (deltas) => {
        if (fail) throw new Error('disk full');
        ledger.addUsage(deltas);
      },
    };
    expect(() => meter.flush(sink)).toThrow('disk full');
    fail = false;
    meter.flush(sink);
    meter.flush(sink);
    expect(new UsageMeter(ledger.loadUsage()).totalFor('key-a').requests).toBe(2);
  });

  it('renders the counts for monitoring, one series per tenant and operation', () => {
    const meter = new UsageMeter();
    run(new UsageRecorder({ ledger, meter, now: () => AT }), SCRIPT.slice(0, 1));
    const text = renderUsageMetrics(meter.snapshot());
    expect(text).toContain('# TYPE gateway_tenant_requests_total counter');
    expect(text).toContain('gateway_tenant_requests_total{tenant="key-a",operation="PutObject"} 1');
    expect(text).toContain(
      `gateway_tenant_billable_bytes_in_total{tenant="key-a",operation="PutObject"} ${UNIT}`
    );
    expect(text).toContain(
      'gateway_tenant_billable_bytes_out_total{tenant="key-a",operation="PutObject"} 0'
    );
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes label values in the monitoring text', () => {
    const text = renderUsageMetrics([row('a"b\\c\nd', 'PutObject', 1, 0, 0)]);
    expect(text).toContain('tenant="a\\"b\\\\c\\nd"');
  });
});

describe('write ledger', () => {
  it('lists every object written in a scripted run, multipart completions included', () => {
    run(new UsageRecorder({ ledger, meter: new UsageMeter(), now: () => AT }), SCRIPT);
    const objects = ledger.listObjects(TENANT_A.folder);
    expect(objects.map((o) => o.objectKey)).toEqual([
      `${TENANT_A.folder}/a.png`,
      `${TENANT_A.folder}/b.png`,
      `${TENANT_A.folder}/big.bin`,
      `${TENANT_A.folder}/c.png`,
      `${TENANT_A.folder}/d.png`,
      `${TENANT_A.folder}/e.png`,
    ]);
    const big = objects.find((o) => o.objectKey.endsWith('big.bin'));
    expect(big).toMatchObject({ size: MIB5 + 100, writtenAt: AT, writes: 1 });
    expect(ledger.listObjects(TENANT_B.folder).map((o) => o.objectKey)).toEqual([
      `${TENANT_B.folder}/z.png`,
    ]);
  });

  it('lists the same objects after a restart', () => {
    run(new UsageRecorder({ ledger, meter: new UsageMeter(), now: () => AT }), SCRIPT);
    const before = ledger.listObjects(TENANT_A.folder);
    const writes = ledger.listWrites(TENANT_A.folder);
    ledger.close();
    ledger = SqliteWriteLedger.open(dbPath);
    expect(ledger.listObjects(TENANT_A.folder)).toEqual(before);
    expect(ledger.listWrites(TENANT_A.folder)).toEqual(writes);
    expect(before).toHaveLength(6);
  });

  it('finishes a multipart upload begun before a restart', () => {
    const recorder = new UsageRecorder({ ledger, meter: new UsageMeter(), now: () => AT });
    run(recorder, SCRIPT.slice(5, 7));
    ledger.close();
    ledger = SqliteWriteLedger.open(dbPath);
    const after = new UsageRecorder({ ledger, meter: new UsageMeter(), now: () => AT });
    run(after, SCRIPT.slice(8, 9));
    expect(ledger.listObjects(TENANT_A.folder)[0]).toMatchObject({ size: MIB5 });
  });

  it('records a write whose answer was lost, because the object may exist', () => {
    run(new UsageRecorder({ ledger, meter: new UsageMeter(), now: () => AT }), [
      {
        tenant: TENANT_A,
        route: route('PutObject', TENANT_A, 'lost.png'),
        bodySize: 5,
        status: 504,
      },
    ]);
    expect(ledger.listObjects(TENANT_A.folder).map((o) => o.objectKey)).toEqual([
      `${TENANT_A.folder}/lost.png`,
    ]);
  });

  it('records a write before the upstream call, so a crash in between hides nothing', () => {
    const recorder = new UsageRecorder({ ledger, meter: new UsageMeter(), now: () => AT });
    recorder.beforeUpstream({
      tenant: TENANT_A,
      route: route('PutObject', TENANT_A, 'inflight.png'),
      bodySize: 7,
    });
    expect(ledger.listObjects(TENANT_A.folder)).toHaveLength(1);
  });

  it('keeps every write to a name and reports the latest', () => {
    let clock = 0;
    const recorder = new UsageRecorder({
      ledger,
      meter: new UsageMeter(),
      now: () => `2026-10-06T00:00:0${(clock += 1)}.000Z`,
    });
    run(recorder, [
      {
        tenant: TENANT_A,
        route: route('PutObject', TENANT_A, 'same.png'),
        bodySize: 10,
        status: 200,
      },
      {
        tenant: TENANT_A,
        route: route('PutObject', TENANT_A, 'same.png'),
        bodySize: 20,
        status: 200,
      },
    ]);
    expect(ledger.listObjects(TENANT_A.folder)).toEqual([
      {
        objectKey: `${TENANT_A.folder}/same.png`,
        size: 20,
        writtenAt: '2026-10-06T00:00:02.000Z',
        writes: 2,
      },
    ]);
    expect(ledger.listWrites(TENANT_A.folder)).toHaveLength(2);
  });

  it('flags a planted object that no write recorded', () => {
    run(new UsageRecorder({ ledger, meter: new UsageMeter(), now: () => AT }), SCRIPT);
    const listed = [
      ...ledger.listObjects(TENANT_A.folder).map((o) => o.objectKey),
      `${TENANT_A.folder}/planted.png`,
    ];
    expect(ledger.findUnrecorded(TENANT_A.folder, listed)).toEqual([
      `${TENANT_A.folder}/planted.png`,
    ]);
    expect(ledger.findUnrecorded(TENANT_A.folder, listed.slice(0, -1))).toEqual([]);
  });

  it('does not mix the parts of two tenants that hold the same upload id', () => {
    ledger.addPart('key-a', 'same-id', 1, 100);
    ledger.addPart('key-b', 'same-id', 1, 900);
    expect(ledger.sumParts('key-a', 'same-id')).toBe(100);
    expect(ledger.sumParts('key-b', 'same-id')).toBe(900);
    ledger.clearParts('key-a', 'same-id');
    expect(ledger.sumParts('key-a', 'same-id')).toBe(0);
    expect(ledger.sumParts('key-b', 'same-id')).toBe(900);
  });

  it('counts a part sent again once, at its latest size', () => {
    ledger.addPart('key-a', 'u', 1, 100);
    ledger.addPart('key-a', 'u', 1, 250);
    ledger.addPart('key-a', 'u', 2, 50);
    expect(ledger.sumParts('key-a', 'u')).toBe(300);
  });

  it('fails the write, so the caller can refuse the request, when the ledger cannot save', () => {
    const recorder = new UsageRecorder({ ledger, meter: new UsageMeter(), now: () => AT });
    ledger.close();
    expect(() =>
      recorder.beforeUpstream({
        tenant: TENANT_A,
        route: route('PutObject', TENANT_A, 'x.png'),
        bodySize: 1,
      })
    ).toThrow();
  });

  it('needs no ledger row for a read, a create or an abort', () => {
    const recorder = new UsageRecorder({ ledger, meter: new UsageMeter(), now: () => AT });
    for (const operation of [
      'GetObject',
      'HeadObject',
      'CreateMultipartUpload',
      'AbortMultipartUpload',
      'UploadPart',
    ] as const) {
      recorder.beforeUpstream({
        tenant: TENANT_A,
        route: route(operation, TENANT_A, 'x'),
        bodySize: 0,
      });
    }
    expect(ledger.listWrites(TENANT_A.folder)).toEqual([]);
  });

  it('refuses a negative size', () => {
    expect(() =>
      ledger.recordWrite({
        keyId: 'k',
        folder: 'f',
        bucket: 'b',
        objectKey: 'f/x',
        size: -1,
        operation: 'PutObject',
        writtenAt: AT,
      })
    ).toThrow();
  });
});
