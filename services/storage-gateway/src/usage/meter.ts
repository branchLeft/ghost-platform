import { billableBytes } from './billing.js';

/** What one tenant has used, for one operation: requests made and billable bytes moved each way. */
export interface UsageCounts {
  readonly requests: number;
  readonly billableBytesIn: number;
  readonly billableBytesOut: number;
}

export interface TenantUsageRow extends UsageCounts {
  readonly keyId: string;
  readonly operation: string;
}

/** Where the meter saves what it has counted since the last save. */
export interface UsageSink {
  addUsage(deltas: readonly TenantUsageRow[]): void;
}

const ZERO: UsageCounts = { requests: 0, billableBytesIn: 0, billableBytesOut: 0 };

function add(a: UsageCounts, b: UsageCounts): UsageCounts {
  return {
    requests: a.requests + b.requests,
    billableBytesIn: a.billableBytesIn + b.billableBytesIn,
    billableBytesOut: a.billableBytesOut + b.billableBytesOut,
  };
}

const slot = (keyId: string, operation: string): string => JSON.stringify([keyId, operation]);

/**
 * Counts every request and every billable byte per tenant and operation.
 * Counts live in memory and are saved in batches by {@link flush}, so a crash
 * can lose the counts since the last flush; the write ledger, which must not
 * lose anything, is written separately and at once.
 */
export class UsageMeter {
  readonly #totals = new Map<string, TenantUsageRow>();
  readonly #pending = new Map<string, TenantUsageRow>();

  constructor(initial: readonly TenantUsageRow[] = []) {
    for (const row of initial) this.#totals.set(slot(row.keyId, row.operation), row);
  }

  /** Counts one request. Bytes are rounded up to billable units here, once per transfer. */
  record(keyId: string, operation: string, bytesIn: number, bytesOut: number): void {
    const delta: UsageCounts = {
      requests: 1,
      billableBytesIn: billableBytes(bytesIn),
      billableBytesOut: billableBytes(bytesOut),
    };
    const key = slot(keyId, operation);
    for (const table of [this.#totals, this.#pending]) {
      const row = table.get(key);
      table.set(key, { keyId, operation, ...add(row ?? ZERO, delta) });
    }
  }

  /** Every tenant's counts, by tenant then operation. */
  snapshot(): TenantUsageRow[] {
    return [...this.#totals.values()].sort(
      (a, b) => a.keyId.localeCompare(b.keyId) || a.operation.localeCompare(b.operation)
    );
  }

  /** One tenant's counts summed over every operation. */
  totalFor(keyId: string): UsageCounts {
    return this.snapshot()
      .filter((row) => row.keyId === keyId)
      .reduce<UsageCounts>((sum, row) => add(sum, row), ZERO);
  }

  /** Saves what was counted since the last flush. Counts are kept if the sink throws. */
  flush(sink: UsageSink): void {
    if (this.#pending.size === 0) return;
    sink.addUsage([...this.#pending.values()]);
    this.#pending.clear();
  }
}

const escapeLabel = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');

/** The counts in the Prometheus text format, one series per tenant and operation. */
export function renderUsageMetrics(rows: readonly TenantUsageRow[]): string {
  const series: [string, string, (row: TenantUsageRow) => number][] = [
    ['gateway_tenant_requests_total', 'Requests made by a tenant.', (r) => r.requests],
    [
      'gateway_tenant_billable_bytes_in_total',
      'Billable bytes a tenant sent, in 64 KiB units.',
      (r) => r.billableBytesIn,
    ],
    [
      'gateway_tenant_billable_bytes_out_total',
      'Billable bytes a tenant received, in 64 KiB units.',
      (r) => r.billableBytesOut,
    ],
  ];
  const lines: string[] = [];
  for (const [name, help, value] of series) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const row of rows) {
      lines.push(
        `${name}{tenant="${escapeLabel(row.keyId)}",operation="${escapeLabel(row.operation)}"} ${value(row)}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
