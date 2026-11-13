/**
 * Upper bounds on every call `runRelease` awaits from outside: the gates,
 * the member lists, one tenant's whole bump and its saved abort, each
 * probe, the promotion record, the bake-window close, a revert, the hold
 * sink and the bake clock's own sleep. A call
 * that has not answered by its deadline is read exactly as if it had thrown,
 * so a hung host fails its member and raises a hold instead of stalling the
 * release with nobody told. The values are incidental; that a bound exists
 * is not. See README.md in this directory.
 */
export interface CallDeadlines {
  /** `runGates()`, once per release, on slot 0. */
  readonly runGatesMs: number;
  /** One tenant's `machine.run()`, backup through verify. */
  readonly bumpMs: number;
  /** One `health()` call, on every soak pass. */
  readonly healthMs: number;
  /** One `reportedErrors()` call, on every soak pass. */
  readonly reportedErrorsMs: number;
  /** One `listMembers()` call, once per ring. */
  readonly listMembersMs: number;
  /** Saving a timed-out bump's abort request (`machine.abort()`). */
  readonly abortMs: number;
  /** One `recordPromotion()` call, once per member. */
  readonly recordPromotionMs: number;
  /** One member's `machine.closeBakeWindow()`, which stops the old colour. */
  readonly closeBakeWindowMs: number;
  /** One regressed member's `machine.abortAfterDone()`, its flag change back. */
  readonly revertMs: number;
  /** One `hold()` call. */
  readonly holdMs: number;
  /** How far past its own length one `clock.sleep(ms)` may run. */
  readonly sleepOverrunMs: number;
}

export const DEFAULT_CALL_DEADLINES: CallDeadlines = Object.freeze({
  runGatesMs: 30 * 60 * 1000,
  bumpMs: 60 * 60 * 1000,
  healthMs: 30 * 1000,
  reportedErrorsMs: 30 * 1000,
  listMembersMs: 60 * 1000,
  abortMs: 60 * 1000,
  recordPromotionMs: 60 * 1000,
  closeBakeWindowMs: 10 * 60 * 1000,
  revertMs: 10 * 60 * 1000,
  holdMs: 60 * 1000,
  sleepOverrunMs: 60 * 1000,
});

const DEADLINE_KEYS = Object.freeze([
  'runGatesMs',
  'bumpMs',
  'healthMs',
  'reportedErrorsMs',
  'listMembersMs',
  'abortMs',
  'recordPromotionMs',
  'closeBakeWindowMs',
  'revertMs',
  'holdMs',
  'sleepOverrunMs',
] as const satisfies readonly (keyof CallDeadlines)[]);

/** The call named did not settle in time. Read as a failure, never as a pass. */
export class DeadlineExceededError extends Error {
  constructor(
    readonly call: string,
    readonly ms: number
  ) {
    super(`${call} did not answer within ${ms}ms`);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Fills in the defaults, then throws on any bound that is not a finite
 * number above zero, before anything is touched. A bound that could never
 * fire would put the hang back.
 */
export function resolveCallDeadlines(overrides: Partial<CallDeadlines> = {}): CallDeadlines {
  const resolved: CallDeadlines = { ...DEFAULT_CALL_DEADLINES, ...overrides };
  for (const key of DEADLINE_KEYS) {
    const ms = resolved[key];
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
      throw new RangeError(
        `call deadline '${key}' needs a finite number of milliseconds above zero`
      );
    }
  }
  return Object.freeze(resolved);
}

/**
 * Settles as `promise` does, or rejects with `DeadlineExceededError` once
 * `ms` has passed, whichever comes first. The timer is cleared on either
 * outcome. A late settlement of `promise` is absorbed, so it can never
 * surface as an unhandled rejection.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, call: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DeadlineExceededError(call, ms));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Bounds on the calls the start-up recovery sweep makes through a record's
 * machine, one set per record. Separate from `CallDeadlines`: those bound
 * what `runRelease` awaits, these bound `recoverPersistedTenants`.
 */
export interface RecoveryDeadlines {
  /** One `revertTraffic()` call. */
  readonly revertTrafficMs: number;
  /** One `stopColour()` call. */
  readonly stopColourMs: number;
  /** One `verify()` call, reached from a recovered `applying` record. */
  readonly verifyMs: number;
  /** One `page()` call. */
  readonly pageMs: number;
}

export const DEFAULT_RECOVERY_DEADLINES: RecoveryDeadlines = Object.freeze({
  revertTrafficMs: 10 * 60 * 1000,
  stopColourMs: 10 * 60 * 1000,
  verifyMs: 5 * 60 * 1000,
  pageMs: 60 * 1000,
});

const RECOVERY_DEADLINE_KEYS = Object.freeze([
  'revertTrafficMs',
  'stopColourMs',
  'verifyMs',
  'pageMs',
] as const satisfies readonly (keyof RecoveryDeadlines)[]);

/** As `resolveCallDeadlines`, for the recovery sweep: defaults filled in, and a bound that could never fire refused. */
export function resolveRecoveryDeadlines(
  overrides: Partial<RecoveryDeadlines> = {}
): RecoveryDeadlines {
  const resolved: RecoveryDeadlines = { ...DEFAULT_RECOVERY_DEADLINES, ...overrides };
  for (const key of RECOVERY_DEADLINE_KEYS) {
    const ms = resolved[key];
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
      throw new RangeError(
        `recovery deadline '${key}' needs a finite number of milliseconds above zero`
      );
    }
  }
  return Object.freeze(resolved);
}
