import type { ApplyLock } from './applyLock.js';

/**
 * The state names themselves are incidental -- what is load-bearing is
 * the behaviour described in `BumpStateMachine`'s own comments: a tenant
 * in `applying` is never interrupted, an abort acts on one tenant with no
 * fleet-wide undo, and `failed-unsafe` pages at least once, is never
 * silently lost, and never triggers an automatic retry of the bump
 * itself.
 */
export type BumpState =
  | 'pending'
  | 'backing-up'
  | 'backed-up'
  | 'applying'
  | 'verifying'
  | 'done'
  | 'closing'
  | 'reverting'
  | 'reverted'
  | 'backup-failed'
  | 'cancelled'
  | 'failed-unsafe'
  | 'closed';

export interface StepResult {
  ok: boolean;
  reason?: string;
}

/** What `persist` durably records: the step, whether the one page has gone out, the bump's own stable id (so recovery can rebuild the identical `page()` dedupe key), and (for `failed-unsafe` only) the reason it would page with. */
export interface PersistSnapshot {
  state: BumpState;
  pageSent: boolean;
  bumpId: string;
  reason?: string;
}

/**
 * Every side effect is injected, never called directly, so this state
 * machine stays pure code, tested against a fake slot. See README.md in
 * this directory for how these map to the broker, backup worker and
 * drain flag.
 */
export interface BumpDependencies {
  /**
   * Take and verify a fresh backup: the dump's own floor assertion, not a
   * restore drill (LLD-4 U8) -- shaped after the backup worker's own
   * dump-result type, not reimplemented here.
   */
  backup(): Promise<StepResult>;
  /**
   * Boot the new colour drained, migrate it and bring it to healthy --
   * the step Ghost holds `migrations_lock` for (LLD-4 U2). The caller
   * awaits this to completion, success or failure, regardless of any
   * abort request: interrupting it is the unrecoverable half-applied
   * state the whole design exists to avoid. A crash while this is in
   * flight is recovered through `recoverFromApplying`, never by calling
   * this a second time.
   */
  apply(): Promise<StepResult>;
  /**
   * Only used by recovery: probes whether a migration a crash
   * interrupted mid-`apply()` has since settled. See README.md in this
   * directory for what counts as positive evidence and why a free lock
   * alone does not.
   */
  awaitApplySettled(): Promise<StepResult>;
  /** Confirm the new colour is genuinely serving before traffic depends on it alone. */
  verify(): Promise<StepResult>;
  /**
   * Move traffic back to the old colour by a flag change -- never a
   * migration undo. The controller never undoes a migration
   * automatically -- resolved by a recorded owner ruling (see
   * `../README.md`'s "What this module deliberately does not build");
   * this is a routing decision, not a schema one.
   */
  revertTraffic(): Promise<StepResult>;
  /**
   * Tear down one colour: the failed new one after a revert, or the old
   * one once the bake window closes with nothing wrong. Idempotent --
   * recovery may call this again for a colour already torn down, so a
   * repeated call must be a safe no-op, never an error.
   */
  stopColour(which: 'new' | 'old'): Promise<void>;
  /**
   * The one page signal for a tenant automation could neither verify nor
   * undo, at-least-once not exactly-once, deduped by `${bumpId}:${reason}`.
   * See README.md in this directory for the crash-then-recovery duplicate
   * case this is shaped for.
   */
  page(reason: string, dedupeKey: string): Promise<void>;
  /**
   * Durably record the step being entered (and, for `failed-unsafe`,
   * whether its one page has actually gone out), before the side effect
   * for that step runs. Optional so the pure-logic tests above can keep
   * testing this class with no filesystem in the loop; a real caller
   * wires this to a `TenantStateStore` so a crash mid-step is recoverable
   * instead of silent.
   */
  persist?(snapshot: PersistSnapshot): Promise<void>;
}

/** Constructor-only: rehydrates an instance recovered from a persisted record, rather than starting fresh at `pending`. */
export interface RecoveredBumpState {
  state: BumpState;
  pageSent?: boolean;
}

export interface BumpStateMachineOptions {
  /**
   * A stable identity for this bump, constant across a crash and restart.
   * Required, never generated internally. See README.md in this
   * directory for why the caller must supply it.
   */
  bumpId: string;
  /**
   * Bounds `recoverFromApplying`'s settlement probe. A generous default
   * (ten minutes) -- long enough for a real migration to finish, short
   * enough that an unreachable or wedged signal cannot hang startup
   * forever. A throw and a timeout are treated identically: "cannot
   * tell", never a pass.
   */
  applySettleTimeoutMs?: number;
  /** Rehydrates an instance recovered from a persisted record, rather than starting fresh at `pending`. */
  recovered?: RecoveredBumpState;
}

const DEFAULT_APPLY_SETTLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Drives one tenant's bump from `pending` to a terminal state, and holds
 * the abort flag that can land at any point along the way. Two tenants
 * sharing one `ApplyLock` can never both be inside `applying` at once --
 * and that lock is only sufficient because exactly one process ever holds
 * it (see `processLock.ts`); this class itself assumes nothing about
 * process topology.
 */
export class BumpStateMachine {
  private state: BumpState = 'pending';
  private abortRequested = false;
  private pageSent = false;
  /**
   * Set synchronously, with no `await` between the read and the write, so
   * that whichever of `closeBakeWindow()`/`abortAfterDone()` is called
   * first -- even in the very same tick as the other -- is the only one
   * that ever proceeds past `done`.
   */
  private doneTransitionClaimed = false;
  private readonly bumpId: string;
  private readonly applySettleTimeoutMs: number;

  constructor(
    private readonly deps: BumpDependencies,
    private readonly lock: ApplyLock,
    options: BumpStateMachineOptions
  ) {
    this.bumpId = options.bumpId;
    this.applySettleTimeoutMs = options.applySettleTimeoutMs ?? DEFAULT_APPLY_SETTLE_TIMEOUT_MS;
    if (options.recovered) {
      this.state = options.recovered.state;
      this.pageSent = options.recovered.pageSent ?? false;
    }
  }

  getState(): BumpState {
    return this.state;
  }

  /**
   * Request an abort. Safe to call at any point in the run; what it does
   * depends on the state the request lands in, per LLD-4 §05's table:
   * `pending`/`backing-up`/`backed-up` cancel cleanly, `applying` is
   * never interrupted, and `verifying`/`done` revert.
   */
  abort(): void {
    this.abortRequested = true;
  }

  /**
   * Runs the whole happy-path sequence, or stops early on an abort or a
   * failure, per the table. Resolves to the terminal state reached.
   */
  async run(): Promise<BumpState> {
    if (this.state !== 'pending') {
      // Refusing this outright, rather than leaving it to the caller's
      // own discipline, is what makes "never retries by itself" true of
      // the whole object, not just of `failUnsafe`'s own guard.
      throw new Error(`run() called from state '${this.state}', expected 'pending'`);
    }

    if (this.abortRequested) {
      await this.transition('cancelled');
      return this.state;
    }

    await this.transition('backing-up');
    const backupResult = await this.deps.backup();

    if (this.abortRequested) {
      // "let the backup finish, then cancel" -- the backup itself is
      // never undone; a spare backup costs nothing.
      await this.transition('cancelled');
      return this.state;
    }
    if (!backupResult.ok) {
      // Nothing has touched the tenant yet, so a failed backup is a
      // clean stop, not the unsafe state `failed-unsafe` names.
      await this.transition('backup-failed');
      return this.state;
    }

    // Nothing yields between the abort check just above and this
    // assignment, so a request landing in 'backed-up' is indistinguishable
    // from one landing in 'backing-up' -- the check above already covers
    // it; a second one here would be dead code, never independently
    // reachable.
    await this.transition('backed-up');

    // 'applying' is persisted only once the lock is actually held and
    // apply() is about to run -- never while merely queued behind
    // another tenant's turn. Persisting it earlier would put every
    // waiting tenant on disk as 'applying', indistinguishable from one
    // whose migration is genuinely in flight, and would itself violate
    // "at most one tenant ever in applying".
    const applyResult = await this.lock.run(async () => {
      await this.transition('applying');
      return this.deps.apply();
    });
    // Never interrupted: awaited to completion, abort or not, whether it
    // resolves ok or not. Serialised within this process by the shared
    // lock, so at most one tenant is ever in this state -- fleet-wide only
    // because exactly one such process runs (the process lock's job).

    if (!applyResult.ok || this.abortRequested) {
      // "applying -> WAIT... then treat as verifying": jump straight to
      // verifying's own abort rule (revert) without ever calling
      // `verify()` -- a pending abort, or the failed apply itself, has
      // already overridden whatever a health check would say.
      await this.transition('verifying');
      return this.revertOrFailUnsafe(applyResult.reason);
    }

    return this.verifyAndFinish();
  }

  /**
   * A tenant recovered from a persisted `applying` record after a crash.
   * See README.md in this directory for why this waits on
   * `awaitApplySettled()` rather than calling `apply()` again, and why
   * it holds the same `ApplyLock` a live `apply()` does.
   */
  async recoverFromApplying(): Promise<BumpState> {
    if (this.state !== 'applying') {
      throw new Error(`recoverFromApplying called from state '${this.state}', expected 'applying'`);
    }
    return this.lock.run(async () => {
      const settled = await this.probeApplySettled();
      if (!settled.ok) {
        return this.failUnsafe(
          settled.reason ?? 'could not confirm the migration settled after a crash'
        );
      }
      return this.verifyAndFinish();
    });
  }

  /**
   * A tenant recovered from a persisted `verifying` or `reverting`
   * record. Neither state has a completed outcome to trust -- the
   * process died before finding out -- so the table's rule for landing
   * in `verifying` applies: revert. `revertTraffic()` is a flag flip,
   * safe to run again even if the crashed run had already flipped it.
   */
  async recoverFromRevertInFlight(): Promise<BumpState> {
    if (this.state !== 'verifying' && this.state !== 'reverting') {
      throw new Error(
        `recoverFromRevertInFlight called from state '${this.state}', expected 'verifying' or 'reverting'`
      );
    }
    return this.revertOrFailUnsafe();
  }

  /**
   * A tenant recovered from a persisted `reverted` record: the revert
   * itself succeeded, but the crash may have landed before the new
   * colour's teardown ran. Retrying `stopColour('new')` is safe -- tearing
   * down an already-stopped colour is a no-op for whatever runs it.
   */
  async recoverFromReverted(): Promise<BumpState> {
    if (this.state !== 'reverted') {
      throw new Error(`recoverFromReverted called from state '${this.state}', expected 'reverted'`);
    }
    await this.deps.stopColour('new');
    return this.state;
  }

  /**
   * A tenant recovered from a persisted `closing` record: `closeBakeWindow`
   * had already claimed `done` and started tearing down the old colour
   * when the crash landed, so the claim (and the fact that this is not a
   * fresh `done`) must not be re-decided -- only the teardown is retried
   * and the terminal state recorded.
   */
  async recoverFromClosing(): Promise<BumpState> {
    if (this.state !== 'closing') {
      throw new Error(`recoverFromClosing called from state '${this.state}', expected 'closing'`);
    }
    await this.deps.stopColour('old');
    await this.transition('closed');
    return this.state;
  }

  /**
   * A tenant recovered from a persisted `failed-unsafe` record whose page
   * was never confirmed sent. The crash landed between recording the
   * state and calling `page()` -- the reason `failed-unsafe` alone is
   * never treated as settled by recovery, only `failed-unsafe` with
   * `pageSent: true` is. Pages now -- this recovery path IS the
   * at-least-once retry `page()`'s own contract describes -- and persists
   * `pageSent: true` so a later restart, once it has actually gone out,
   * does not.
   */
  async recoverUnpagedFailure(reason: string): Promise<BumpState> {
    if (this.state !== 'failed-unsafe') {
      throw new Error(
        `recoverUnpagedFailure called from state '${this.state}', expected 'failed-unsafe'`
      );
    }
    if (!this.pageSent) {
      await this.deps.page(reason, this.dedupeKey(reason));
      this.pageSent = true;
      await this.persistSnapshot(reason);
    }
    return this.state;
  }

  /**
   * A tenant recovered from a persisted `pending`, `backing-up` or
   * `backed-up` record: none of these has an uninterruptible side effect
   * in flight, so the abort table's own rule for landing here -- cancel
   * cleanly -- is the recovery action too. `backup()` is never resumed or
   * retried on this path; a spare backup from before the crash, if one
   * exists, costs nothing left uncollected.
   */
  async recoverAsCancelled(): Promise<BumpState> {
    if (this.state !== 'pending' && this.state !== 'backing-up' && this.state !== 'backed-up') {
      throw new Error(
        `recoverAsCancelled called from state '${this.state}', expected 'pending', 'backing-up' or 'backed-up'`
      );
    }
    await this.transition('cancelled');
    return this.state;
  }

  /**
   * Abort landing after `run()` has already resolved to `done`: still
   * inside the bake window, so a flag change back to the old colour is
   * still the whole mechanism. Also how the ring's own watcher reports a
   * post-`done` health regression during the bake window.
   */
  async abortAfterDone(): Promise<BumpState> {
    this.claimDoneTransition('abortAfterDone');
    this.abortRequested = true;
    return this.revertOrFailUnsafe();
  }

  /**
   * The far end of a clean bump: the bake window elapsed with nothing
   * wrong, so the old colour is stopped. This is the U7 reading this
   * component builds: past this point a fault is `failed-unsafe`, never
   * an automatic migration down and never a restore. `closing` is
   * persisted before the teardown itself runs, so a crash between the
   * stop and recording `closed` recovers as a retried (idempotent) stop,
   * never as a still-open bake window with the old colour already gone.
   */
  async closeBakeWindow(): Promise<BumpState> {
    this.claimDoneTransition('closeBakeWindow');
    await this.transition('closing');
    await this.deps.stopColour('old');
    await this.transition('closed');
    return this.state;
  }

  /**
   * The single gate both `done`-only calls pass through. Read-then-write
   * with no `await` in between: two calls landing in the same tick (a
   * bake-window timer firing the same turn as the watcher's health
   * regression) still only let one of them claim it, because JavaScript
   * never interleaves this synchronous body with anything else.
   */
  private claimDoneTransition(caller: string): void {
    if (this.state !== 'done' || this.doneTransitionClaimed) {
      throw new Error(`${caller} called from state '${this.state}', not 'done'`);
    }
    this.doneTransitionClaimed = true;
  }

  /**
   * The shared tail of a completed, settled, successful `apply()` (real
   * or recovered): check health, then land on `done` or hand off to the
   * revert path. See README.md in this directory for which callers reach
   * this and how a throwing `verify()` is handled.
   */
  private async verifyAndFinish(): Promise<BumpState> {
    await this.transition('verifying');

    let verifyResult: StepResult;
    try {
      verifyResult = await this.deps.verify();
    } catch (err) {
      return this.failUnsafe(err instanceof Error ? err.message : 'verify() threw');
    }

    if (verifyResult.ok && !this.abortRequested) {
      await this.transition('done');
      return this.state;
    }

    return this.revertOrFailUnsafe(verifyResult.reason);
  }

  /**
   * `verifying`/`done` -> revert, and the same rule applies whether an
   * abort asked for it or the step failed on its own: an unhealthy or
   * unwanted new colour is never left serving alone. A revert that
   * itself cannot succeed is the "unrevertable" case that pages.
   */
  private async revertOrFailUnsafe(reason?: string): Promise<BumpState> {
    await this.transition('reverting');
    const revertResult = await this.deps.revertTraffic();

    if (revertResult.ok) {
      await this.transition('reverted');
      await this.deps.stopColour('new');
      return this.state;
    }

    return this.failUnsafe(revertResult.reason ?? reason ?? 'revert failed');
  }

  /**
   * Pages at least once, ever, for this bump -- never relied on to be
   * exactly once across a restart. See README.md in this directory for
   * the persist-before-page ordering this depends on.
   */
  private async failUnsafe(reason: string): Promise<BumpState> {
    this.state = 'failed-unsafe';
    await this.persistSnapshot(reason);
    if (!this.pageSent) {
      await this.deps.page(reason, this.dedupeKey(reason));
      this.pageSent = true;
      await this.persistSnapshot(reason);
    }
    return this.state;
  }

  /**
   * Never trusts `awaitApplySettled()` to bound or contain itself: a
   * throw or a hang past `applySettleTimeoutMs` both collapse to the
   * same `ok: false`. See README.md in this directory for why an
   * unguarded probe would endanger the rest of the recovery sweep.
   */
  private async probeApplySettled(): Promise<StepResult> {
    try {
      return await withTimeout(this.deps.awaitApplySettled(), this.applySettleTimeoutMs);
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'awaitApplySettled() failed',
      };
    }
  }

  /**
   * Every state change goes through here: set the field (synchronously,
   * before any `await`, so `getState()` reflects it immediately), then
   * durably record it, before whatever side effect belongs to that state
   * actually runs. `persist` is optional, so this is a no-op for the
   * pure-logic tests that supply no store.
   */
  private async transition(state: BumpState): Promise<void> {
    this.state = state;
    await this.persistSnapshot();
  }

  private async persistSnapshot(reason?: string): Promise<void> {
    await this.deps.persist?.({
      state: this.state,
      pageSent: this.pageSent,
      bumpId: this.bumpId,
      reason,
    });
  }

  /** `${bumpId}:${reason}` -- see `page()`'s own doc for why both halves matter. */
  private dedupeKey(reason: string): string {
    return `${this.bumpId}:${reason}`;
  }
}

/**
 * Races `promise` against a bound, rejecting on the timer rather than
 * ever leaving the caller waiting on a dependency that neither resolves
 * nor rejects. The timer is always cleared, on either outcome, so a fast
 * `promise` never leaves a dangling timer behind.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
