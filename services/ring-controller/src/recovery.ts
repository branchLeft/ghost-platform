import type { ApplyLock } from './applyLock.js';
import { BumpStateMachine, type BumpDependencies, type BumpState } from './bumpStateMachine.js';
import type { PersistedTenantState, TenantStateStore } from './tenantStateStore.js';

export interface RecoveredTenant {
  tenantId: string;
  machine: BumpStateMachine;
  finalState: BumpState;
}

/** A tenant this sweep could not recover. Its persisted record is untouched, so the next restart tries again -- but nothing else retries it until then, so this must not be silently dropped. */
export interface RecoveryFailure {
  tenantId: string;
  error: unknown;
}

export interface RecoverySweepResult {
  recovered: RecoveredTenant[];
  failed: RecoveryFailure[];
}

/**
 * States with no in-flight side effect and nothing still owed to the
 * tenant: no bake window open (that's `done`), no unpaged page owed
 * (that's `failed-unsafe` with `pageSent: false`, handled separately
 * below). Genuinely nothing to do on restart.
 */
const NO_ACTION_STATES: ReadonlySet<BumpState> = new Set(['closed', 'backup-failed', 'cancelled']);

/**
 * Runs once at controller startup for every tenant a crash left with a
 * persisted record still owing something. See README.md in this
 * directory for the recovery table this follows.
 */
export async function recoverPersistedTenants(
  store: TenantStateStore,
  lock: ApplyLock,
  buildDeps: (tenantId: string) => BumpDependencies
): Promise<RecoverySweepResult> {
  const records = await store.list();
  const recovered: RecoveredTenant[] = [];
  const failed: RecoveryFailure[] = [];

  for (const record of records) {
    if (record.state === 'failed-unsafe' && record.pageSent) {
      // Truly settled: the one page already went out.
      continue;
    }
    if (NO_ACTION_STATES.has(record.state)) {
      continue;
    }

    // One tenant's recovery must never take the rest of this sweep down
    // with it -- especially a `failed-unsafe`/`pageSent: false` tenant
    // still waiting on its one page, which could otherwise be lost to
    // an entirely unrelated tenant's throw earlier in the same loop.
    // `recoverFromApplying` already contains its own probe's throw or
    // hang (`probeApplySettled`); this is the outer, defensive layer for
    // anything else that still manages to reject. But a failure here
    // must never be silent either: its own page (if it was owed one) is
    // now stuck until the next restart, and the caller needs to be able
    // to tell "nothing left to recover" from "recovery itself failed".
    try {
      const machine = new BumpStateMachine(buildDeps(record.tenantId), lock, {
        // Read back the exact bumpId the live process persisted, so the
        // dedupe key a recovery page carries is identical to the one a
        // live page for the same bump already used -- falling back to
        // the tenant id only for a record written before this field
        // existed.
        bumpId: record.bumpId ?? record.tenantId,
        recovered: { state: record.state, pageSent: record.pageSent },
      });
      const finalState = await runRecoveryAction(machine, record);
      recovered.push({ tenantId: record.tenantId, machine, finalState });
    } catch (error) {
      console.error(
        `ring-controller: recovery failed for tenant '${record.tenantId}' (persisted state '${record.state}'); its record is untouched, so this is retried on the next restart, not before`,
        error
      );
      failed.push({ tenantId: record.tenantId, error });
    }
  }

  return { recovered, failed };
}

function runRecoveryAction(
  machine: BumpStateMachine,
  record: PersistedTenantState
): Promise<BumpState> {
  switch (record.state) {
    case 'pending':
    case 'backing-up':
    case 'backed-up':
      return machine.recoverAsCancelled();
    case 'applying':
      // The one state this whole mechanism exists to protect: never call
      // apply() a second time, and never act on the colour until the
      // migration is confirmed settled, whatever the crash landed on.
      return machine.recoverFromApplying();
    case 'verifying':
    case 'reverting':
      return machine.recoverFromRevertInFlight();
    case 'reverted':
      return machine.recoverFromReverted();
    case 'closing':
      return machine.recoverFromClosing();
    case 'done':
      // Already correct on disk -- only the in-memory object was lost.
      // Rehydrating it (done above) is the entire recovery action.
      return Promise.resolve(machine.getState());
    case 'failed-unsafe':
      // Reached only when pageSent is false (the settled case is
      // filtered out above): the crash landed between recording the
      // state and actually paging.
      return machine.recoverUnpagedFailure(
        record.reason ?? 'recovered unpaged failure after a crash'
      );
    default:
      throw new Error(`no recovery action defined for persisted state '${record.state}'`);
  }
}
