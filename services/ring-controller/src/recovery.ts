import type { ApplyLock } from './applyLock.js';
import { BumpStateMachine, type BumpDependencies, type BumpState } from './bumpStateMachine.js';
import type { PersistedTenantState, TenantStateStore } from './tenantStateStore.js';

export interface RecoveredTenant {
  tenantId: string;
  machine: BumpStateMachine;
  finalState: BumpState;
}

/**
 * States with no in-flight side effect and nothing still owed to the
 * tenant: no bake window open (that's `done`), no unpaged page owed
 * (that's `failed-unsafe` with `pageSent: false`, handled separately
 * below). Genuinely nothing to do on restart.
 */
const NO_ACTION_STATES: ReadonlySet<BumpState> = new Set(['closed', 'backup-failed', 'cancelled']);

/**
 * Runs once at controller startup, before any new bump is admitted, for
 * every tenant a crash left with a persisted record still owing
 * something. A crash is treated as an abort request the process never
 * got to record -- every action below matches a live `abort()`'s own
 * table -- except `applying`, whose rule ("WAIT... then treat as
 * verifying") is followed literally: `apply()` is never called again for
 * a tenant recovered here, and recovery waits for the migration to
 * actually settle before doing anything else with the colour.
 *
 * `done` is deliberately NOT settled: the bake window is still open, and
 * with no machine rehydrated for it, neither a later `closeBakeWindow()`
 * nor a later `abortAfterDone()` would have anything to act on. It is
 * rehydrated with no recovery action of its own -- the state is already
 * correct, only the in-memory object was lost.
 */
export async function recoverPersistedTenants(
  store: TenantStateStore,
  lock: ApplyLock,
  buildDeps: (tenantId: string) => BumpDependencies
): Promise<RecoveredTenant[]> {
  const records = await store.list();
  const recovered: RecoveredTenant[] = [];

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
    // anything else that still manages to reject.
    try {
      const machine = new BumpStateMachine(buildDeps(record.tenantId), lock, {
        bumpId: record.tenantId,
        recovered: { state: record.state, pageSent: record.pageSent },
      });
      const finalState = await runRecoveryAction(machine, record);
      recovered.push({ tenantId: record.tenantId, machine, finalState });
    } catch {
      // Skip this tenant and carry on to the next record -- never let
      // one unrecoverable tenant stop the sweep from reaching the rest.
      continue;
    }
  }

  return recovered;
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
