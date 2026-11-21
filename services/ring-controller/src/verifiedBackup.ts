import type { StepResult } from './bumpStateMachine.js';

/**
 * What the backup worker's on-demand, one-tenant dump hands back: its FLOOR
 * result, shaped after the worker's own dump result rather than a second
 * implementation of it. `exitCode` is carried so a caller can log it, and
 * is never read by the verdict below.
 */
export interface TenantDumpResult {
  tenant: string;
  ok: boolean;
  exitCode: number;
  /** The floor tables the worker's independent watcher saw in the dump's own bytes. */
  floorTablesSeen: readonly string[];
  /** The floor tables it did not see. Any entry means the dump is not trustworthy. */
  missingFloorTables: readonly string[];
  /** The copies the worker actually stored. */
  copiesWritten: readonly string[];
  error?: string | null;
}

/** Takes one fresh dump of exactly one tenant, on demand. Wired to the backup worker's `run_tenant_dump`. */
export type TakeTenantDump = (tenantId: string) => Promise<TenantDumpResult>;

/**
 * The one verdict on a dump: it is a verified backup only when the dump is
 * for this tenant, the worker's own floor assertion held (every floor table
 * seen, none missing), and at least one copy was stored. The exit code is
 * never consulted: a producer can exit 0 over a dump with an empty floor
 * table, and that is exactly the backup a bump must not rest on. Anything
 * missing, malformed or ambiguous is a refusal.
 */
export function judgeDump(tenantId: string, result: TenantDumpResult): StepResult {
  if (result.tenant !== tenantId) {
    return { ok: false, reason: 'the dump is for a different tenant' };
  }
  const missing = result.missingFloorTables;
  if (!Array.isArray(missing) || missing.length > 0) {
    return {
      ok: false,
      reason: `floor assertion failed: missing ${Array.isArray(missing) ? missing.join(', ') : 'an unreadable floor result'}`,
    };
  }
  if (!Array.isArray(result.floorTablesSeen) || result.floorTablesSeen.length === 0) {
    return { ok: false, reason: 'floor assertion failed: no floor table was seen' };
  }
  if (!result.ok) {
    return { ok: false, reason: result.error ?? 'the dump did not report ok' };
  }
  if (!Array.isArray(result.copiesWritten) || result.copiesWritten.length === 0) {
    return { ok: false, reason: 'no copy of the dump was stored' };
  }
  return { ok: true };
}

/**
 * The `backup()` dependency for one tenant's `BumpStateMachine`: no
 * verified backup, no bump. It asks for an on-demand dump of this one
 * tenant and trusts the dump's floor assertion, never its exit code. A dump
 * that throws is a failed backup, not a thrown bump: nothing has touched the
 * tenant yet, so the machine stops cleanly at `backup-failed`.
 */
export function createVerifiedBackup(
  tenantId: string,
  takeDump: TakeTenantDump
): () => Promise<StepResult> {
  return async () => {
    let result: TenantDumpResult;
    try {
      result = await takeDump(tenantId);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'the dump threw' };
    }
    return judgeDump(tenantId, result);
  };
}
