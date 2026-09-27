import type { ApplyLock } from './applyLock.js';

/**
 * The state names themselves are incidental -- what is load-bearing is
 * the behaviour described in `BumpStateMachine`'s own comments: a tenant
 * in `applying` is never interrupted, an abort acts on one tenant with no
 * fleet-wide undo, and `failed-unsafe` pages exactly once and never
 * retries itself.
 */
export type BumpState =
  | 'pending'
  | 'backing-up'
  | 'backed-up'
  | 'applying'
  | 'verifying'
  | 'done'
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

/**
 * Every side effect is injected, never called directly, so this state
 * machine stays pure code and is tested against a fake slot -- and so it
 * coordinates with the broker's colour swap, the backup worker's
 * on-demand dump and the drain-flag revert rather than reimplementing any
 * of them. Wiring these to the real broker `/reconcile` call, the backup
 * worker's `run_tenant_dump`, and the drain flag is integration work for
 * whatever runs this state machine; this module owns only the sequencing,
 * the abort behaviour above it, and (via `persist`) the durability of
 * which step it is in.
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
  /** Confirm the new colour is genuinely serving before traffic depends on it alone. */
  verify(): Promise<StepResult>;
  /**
   * Move traffic back to the old colour by a flag change -- never a
   * migration undo. The controller never undoes a migration
   * automatically (Rob's ruling on this issue); this is a routing
   * decision, not a schema one.
   */
  revertTraffic(): Promise<StepResult>;
  /** Tear down one colour: the failed new one after a revert, or the old one once the bake window closes with nothing wrong. */
  stopColour(which: 'new' | 'old'): Promise<void>;
  /** The one page signal for a tenant automation could neither verify nor undo. Called at most once per bump, ever. */
  page(reason: string): Promise<void>;
  /**
   * Durably record the state being entered, before the side effect for
   * that state runs. Optional so the pure-logic tests above can keep
   * testing this class with no filesystem in the loop; a real caller
   * wires this to a `TenantStateStore` so a crash mid-step is recoverable
   * instead of silent.
   */
  persist?(state: BumpState): Promise<void>;
}

/** Constructor-only: rehydrates an instance recovered from a persisted record, rather than starting fresh at `pending`. */
export interface RecoveredBumpState {
  state: BumpState;
  pageSent?: boolean;
}

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

  constructor(
    private readonly deps: BumpDependencies,
    private readonly lock: ApplyLock,
    recovered?: RecoveredBumpState
  ) {
    if (recovered) {
      this.state = recovered.state;
      this.pageSent = recovered.pageSent ?? false;
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

    await this.transition('applying');
    // Never interrupted: awaited to completion, abort or not, whether it
    // resolves ok or not. Serialised within this process by the shared
    // lock, so at most one tenant is ever in this state -- fleet-wide only
    // because exactly one such process runs (the process lock's job).
    const applyResult = await this.lock.run(() => this.deps.apply());

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
   * `apply()` is never called again -- the table's own rule for landing
   * in `applying` ("WAIT... then treat as verifying") is followed
   * literally, whatever the crash actually left mid-flight.
   */
  async recoverFromApplying(): Promise<BumpState> {
    if (this.state !== 'applying') {
      throw new Error(`recoverFromApplying called from state '${this.state}', expected 'applying'`);
    }
    return this.verifyAndFinish();
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
   * an automatic migration down and never a restore.
   */
  async closeBakeWindow(): Promise<BumpState> {
    this.claimDoneTransition('closeBakeWindow');
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
   * The shared tail of a completed, successful `apply()` (real or
   * recovered): check health, then land on `done` or hand off to the
   * revert path. Never entered on an apply failure or a pending abort --
   * `run()` and `recoverFromApplying` both route those straight past
   * `verify()` to the revert path instead. Verify itself throwing -- not
   * answering ok or not-ok, just failing to run -- is the "can't be
   * verified" case: it goes straight to `failed-unsafe` rather than being
   * treated as either a pass or an ordinary failure.
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
   * Pages exactly once, ever, for this bump -- never on a second call,
   * however it is reached. Automation that has run out of moves fetches
   * a person once; retrying from here is how one broken tenant becomes
   * two (LLD-4 §05).
   */
  private async failUnsafe(reason: string): Promise<BumpState> {
    await this.transition('failed-unsafe');
    if (!this.pageSent) {
      this.pageSent = true;
      await this.deps.page(reason);
    }
    return this.state;
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
    await this.deps.persist?.(state);
  }
}
