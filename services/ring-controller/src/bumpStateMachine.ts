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
 * whatever runs this state machine; this module owns only the sequencing
 * and the abort behaviour above it.
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
   * state the whole design exists to avoid.
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
}

/**
 * Drives one tenant's bump from `pending` to a terminal state, and holds
 * the abort flag that can land at any point along the way. Two tenants
 * sharing one `ApplyLock` can never both be inside `applying` at once.
 */
export class BumpStateMachine {
  private state: BumpState = 'pending';
  private abortRequested = false;
  private pageSent = false;

  constructor(
    private readonly deps: BumpDependencies,
    private readonly lock: ApplyLock
  ) {}

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
      this.state = 'cancelled';
      return this.state;
    }

    this.state = 'backing-up';
    const backupResult = await this.deps.backup();

    if (this.abortRequested) {
      // "let the backup finish, then cancel" -- the backup itself is
      // never undone; a spare backup costs nothing.
      this.state = 'cancelled';
      return this.state;
    }
    if (!backupResult.ok) {
      // Nothing has touched the tenant yet, so a failed backup is a
      // clean stop, not the unsafe state `failed-unsafe` names.
      this.state = 'backup-failed';
      return this.state;
    }

    // Nothing yields between the abort check just above and this
    // assignment, so a request landing in 'backed-up' is indistinguishable
    // from one landing in 'backing-up' -- the check above already covers
    // it; a second one here would be dead code, never independently
    // reachable.
    this.state = 'backed-up';

    this.state = 'applying';
    // Never interrupted: awaited to completion, abort or not, whether it
    // resolves ok or not. Serialised fleet-wide by the shared lock, so at
    // most one tenant is ever in this state.
    const applyResult = await this.lock.run(() => this.deps.apply());

    if (!applyResult.ok || this.abortRequested) {
      // "applying -> WAIT... then treat as verifying": jump straight to
      // verifying's own abort rule (revert) without running a health
      // check whose answer a pending abort, or the failed apply itself,
      // has already overridden.
      this.state = 'verifying';
      return this.revertOrFailUnsafe(applyResult.reason);
    }

    this.state = 'verifying';
    const verifyResult = await this.deps.verify();

    if (verifyResult.ok && !this.abortRequested) {
      this.state = 'done';
      return this.state;
    }

    return this.revertOrFailUnsafe(verifyResult.reason);
  }

  /**
   * Abort landing after `run()` has already resolved to `done`: still
   * inside the bake window, so a flag change back to the old colour is
   * still the whole mechanism. Also how the ring's own watcher reports a
   * post-`done` health regression during the bake window.
   */
  async abortAfterDone(): Promise<BumpState> {
    if (this.state !== 'done') {
      throw new Error(`abortAfterDone called from state '${this.state}', not 'done'`);
    }
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
    if (this.state !== 'done') {
      throw new Error(`closeBakeWindow called from state '${this.state}', not 'done'`);
    }
    await this.deps.stopColour('old');
    this.state = 'closed';
    return this.state;
  }

  /**
   * `verifying`/`done` -> revert, and the same rule applies whether an
   * abort asked for it or the step failed on its own: an unhealthy or
   * unwanted new colour is never left serving alone. A revert that
   * itself cannot succeed is the "unrevertable" case that pages.
   */
  private async revertOrFailUnsafe(reason?: string): Promise<BumpState> {
    this.state = 'reverting';
    const revertResult = await this.deps.revertTraffic();

    if (revertResult.ok) {
      this.state = 'reverted';
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
    this.state = 'failed-unsafe';
    if (!this.pageSent) {
      this.pageSent = true;
      await this.deps.page(reason);
    }
    return this.state;
  }
}
