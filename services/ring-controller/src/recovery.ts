import type { ApplyLock } from './applyLock.js';
import { BumpStateMachine, type BumpDependencies, type BumpState } from './bumpStateMachine.js';
import type { PersistedTenantState, TenantStateStore } from './tenantStateStore.js';

export interface RecoveredTenant {
  tenantId: string;
  machine: BumpStateMachine;
  finalState: BumpState;
}

const SETTLED_STATES: ReadonlySet<BumpState> = new Set([
  'done',
  'closed',
  'backup-failed',
  'cancelled',
  'failed-unsafe',
]);

/**
 * Runs once at controller startup, before any new bump is admitted, for
 * every tenant a crash left with a persisted, non-terminal record. A
 * crash is treated as an abort request the process never got to record --
 * every action below matches a live `abort()`'s own table -- except
 * `applying`, whose rule ("WAIT... then treat as verifying") is followed
 * literally: `apply()` is never called again for a tenant recovered here,
 * whatever the crash actually left mid-flight.
 */
export async function recoverPersistedTenants(
  store: TenantStateStore,
  lock: ApplyLock,
  buildDeps: (tenantId: string) => BumpDependencies
): Promise<RecoveredTenant[]> {
  const records = await store.list();
  const recovered: RecoveredTenant[] = [];

  for (const record of records) {
    if (SETTLED_STATES.has(record.state)) {
      // Already at a resting state with no in-flight side effect --
      // nothing to resume or cancel.
      continue;
    }

    const machine = new BumpStateMachine(buildDeps(record.tenantId), lock, {
      state: record.state,
      pageSent: record.pageSent,
    });

    const finalState = await runRecoveryAction(machine, record);
    recovered.push({ tenantId: record.tenantId, machine, finalState });
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
      // apply() a second time, whatever the crash landed on.
      return machine.recoverFromApplying();
    case 'verifying':
    case 'reverting':
      return machine.recoverFromRevertInFlight();
    case 'reverted':
      return machine.recoverFromReverted();
    default:
      throw new Error(`no recovery action defined for persisted state '${record.state}'`);
  }
}
