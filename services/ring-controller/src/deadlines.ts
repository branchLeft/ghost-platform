/**
 * Upper bounds on the calls `runRelease` awaits from outside: the gates,
 * one tenant's whole bump, and each health and reported-error probe. A call
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
}

export const DEFAULT_CALL_DEADLINES: CallDeadlines = Object.freeze({
  runGatesMs: 30 * 60 * 1000,
  bumpMs: 60 * 60 * 1000,
  healthMs: 30 * 1000,
  reportedErrorsMs: 30 * 1000,
});

const DEADLINE_KEYS = Object.freeze([
  'runGatesMs',
  'bumpMs',
  'healthMs',
  'reportedErrorsMs',
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
