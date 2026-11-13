import type { ApplyLock } from './applyLock.js';
import { BumpStateMachine, type BumpDependencies, type BumpState } from './bumpStateMachine.js';
import {
  DeadlineExceededError,
  resolveRecoveryDeadlines,
  withDeadline,
  type RecoveryDeadlines,
} from './deadlines.js';
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
  /** True when the failure was a call that missed its limit and the sweep paged the tenant for it. False when it was not paged: another kind of failure, or the page itself failed or missed its limit (the record is then still owed it). */
  paged: boolean;
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
 * The three calls recovery makes that nothing else bounds, each held to its
 * own limit per call. A call that misses its limit rejects, which the
 * machine and the sweep already treat as any other throw. Every member is
 * named, not spread, so a `deps` that is a class instance keeps its `this`.
 */
function boundedForRecovery(deps: BumpDependencies, limits: RecoveryDeadlines): BumpDependencies {
  const bounded: BumpDependencies = {
    backup: () => deps.backup(),
    apply: () => deps.apply(),
    awaitApplySettled: () => deps.awaitApplySettled(),
    verify: () => deps.verify(),
    revertTraffic: () =>
      withDeadline(deps.revertTraffic(), limits.revertTrafficMs, 'revertTraffic()'),
    stopColour: (which) =>
      withDeadline(deps.stopColour(which), limits.stopColourMs, 'stopColour()'),
    page: (reason, dedupeKey) =>
      withDeadline(deps.page(reason, dedupeKey), limits.pageMs, 'page()'),
  };
  const { persist } = deps;
  if (persist !== undefined) {
    bounded.persist = (snapshot) => persist.call(deps, snapshot);
  }
  return bounded;
}

/**
 * Runs once at controller startup for every tenant a crash left with a
 * persisted record still owing something. See README.md in this
 * directory for the recovery table this follows.
 *
 * `revertTraffic()`, `stopColour()` and `page()` each have a per-call limit
 * (`deadlines`, defaults in `DEFAULT_RECOVERY_DEADLINES`), so one hung host
 * costs its own record that long and no record after it anything.
 */
export async function recoverPersistedTenants(
  store: TenantStateStore,
  lock: ApplyLock,
  buildDeps: (tenantId: string) => BumpDependencies,
  deadlines: Partial<RecoveryDeadlines> = {}
): Promise<RecoverySweepResult> {
  const limits = resolveRecoveryDeadlines(deadlines);
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
    let deps: BumpDependencies | undefined;
    try {
      deps = boundedForRecovery(buildDeps(record.tenantId), limits);
      const machine = new BumpStateMachine(deps, lock, {
        // Read back the exact bumpId the live process persisted, so the
        // dedupe key a recovery page carries is identical to the one a
        // live page for the same bump already used -- falling back to
        // the tenant id only for a record written before this field
        // existed.
        bumpId: record.bumpId ?? record.tenantId,
        recovered: {
          state: record.state,
          pageSent: record.pageSent,
          abortRequested: record.abortRequested === true,
        },
      });
      const finalState = await runRecoveryAction(machine, record);
      recovered.push({ tenantId: record.tenantId, machine, finalState });
    } catch (error) {
      console.error(
        `ring-controller: recovery failed for tenant '${record.tenantId}' (persisted state '${record.state}'); its record is untouched, so this is retried on the next restart, not before`,
        error
      );
      failed.push({
        tenantId: record.tenantId,
        error,
        paged: deps !== undefined && (await pageForTimeout(record, error, deps)),
      });
    }
  }

  return { recovered, failed };
}

/**
 * A `stopColour()` that missed its limit leaves a record (`reverted`,
 * `closing`) the machine does not turn into a page of its own, and nothing
 * else retries it until the next restart. So the sweep pages it, once, with
 * the same `${bumpId}:${reason}` dedupe key shape a machine page uses. The
 * record is left as it is, so the next restart retries the teardown. A
 * `page()` that itself missed its limit cannot be paged for: the record
 * stays owed its page (`failed-unsafe` with `pageSent: false` is retried on
 * the next restart) and the failure says `paged: false`. A `revertTraffic()`
 * that missed its limit never gets here: the machine turns it into
 * `failed-unsafe` and pages it.
 */
async function pageForTimeout(
  record: PersistedTenantState,
  error: unknown,
  deps: BumpDependencies
): Promise<boolean> {
  if (!(error instanceof DeadlineExceededError) || error.call !== 'stopColour()') {
    return false;
  }
  const reason = `recovery of '${record.state}' did not finish: ${error.message}`;
  try {
    await deps.page(reason, `${record.bumpId ?? record.tenantId}:${reason}`);
    return true;
  } catch (pageError) {
    console.error(
      `ring-controller: could not page for tenant '${record.tenantId}' after its recovery timed out`,
      pageError
    );
    return false;
  }
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
      if (record.abortRequested === true) {
        // The crashed process had given up on this tenant's bake: nobody
        // will ever watch it, so revert, exactly as a live abort in
        // 'done' does.
        return machine.abortAfterDone();
      }
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
