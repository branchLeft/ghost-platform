import type { EntryPoint, StepId } from './plan.js';
import type { PlanPorts } from './ports.js';

/**
 * The side effects the executor can cause, one port each. Nothing here lets
 * a caller pass anything but a planned step: host ports receive the step's
 * register-derived inputs and secret names and return nothing, so no secret
 * value travels through the controller.
 */

/** What a host entry point is asked to do. `idempotencyKey` is `<step key>@<input digest>`. */
export interface StepRequest {
  readonly key: string;
  readonly id: StepId;
  readonly idempotencyKey: string;
  readonly inputs: Readonly<Record<string, string | number | readonly string[]>>;
}

/**
 * One narrow entry point on a host. It must be idempotent on `idempotencyKey`:
 * a second call with the same key after the first took effect changes nothing.
 * It throws to fail, with a message that carries no secret value, and throws
 * `PermanentStepError` when retrying cannot help. It returns nothing.
 */
export interface HostEntryPoint {
  run(request: StepRequest): Promise<void>;
}

export type HostPorts = Readonly<Record<EntryPoint, HostEntryPoint>>;

export const STEP_EVENTS = [
  'started',
  'complete',
  'attempt-failed',
  'step-failed',
  'digest-mismatch',
] as const;
export const RUN_EVENTS = ['run-halted', 'run-complete'] as const;
export type StateEvent = (typeof STEP_EVENTS)[number] | (typeof RUN_EVENTS)[number];

/** One line of the append-only history. Step events carry `key` and `inputDigest`. */
export interface StateRecord {
  readonly at: string;
  readonly approvalId: string;
  readonly event: StateEvent;
  readonly key?: string;
  readonly inputDigest?: string;
  readonly attempt?: number;
  readonly reason?: string;
}

/**
 * Append-only, durable history. `append` resolves only once the record would
 * survive a crash. `readAll` throws when the history cannot be trusted; the
 * executor then runs nothing.
 */
export interface StateStore {
  readAll(): Promise<readonly StateRecord[]>;
  append(record: StateRecord): Promise<void>;
}

export const PROGRESS_TYPES = [
  'run-started',
  'step-started',
  'step-complete',
  'step-skipped',
  'step-retrying',
  'step-failed',
  'step-refused',
  'run-halted',
  'run-complete',
] as const;
export type ProgressType = (typeof PROGRESS_TYPES)[number];

/** What the console is told: identifiers, counts and a reason, never inputs. */
export interface ProgressEvent {
  readonly type: ProgressType;
  readonly at: string;
  readonly approvalId: string;
  readonly tenantId?: string;
  readonly key?: string;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly reason?: string;
}

export interface ConsoleReporter {
  report(event: ProgressEvent): Promise<void>;
}

export interface Clock {
  /** An ISO 8601 instant. */
  now(): string;
  sleep(ms: number): Promise<void>;
}

/** Everything the executor needs: the planner's reads plus the five side-effect ports. */
export interface ExecutePorts extends PlanPorts {
  readonly hosts: HostPorts;
  readonly state: StateStore;
  readonly console: ConsoleReporter;
  readonly clock: Clock;
}

export interface RetryPolicy {
  /** Total tries per step, first included. At least 1. */
  readonly maxAttempts: number;
  /** Wait after the first failure; doubles each time. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface RunOptions {
  readonly retry?: RetryPolicy;
  /**
   * The longest the run waits for one console report before counting it lost
   * and going on (default 2000). A slow console must not stretch the time
   * between the approval check and the host call.
   */
  readonly reportTimeoutMs?: number;
}

export type StopReason = 'step-failed' | 'input-changed';

export interface RunResult {
  readonly status: 'complete' | 'stopped';
  readonly approvalId: string;
  readonly tenantId: string;
  /** Steps this call carried out, in order. */
  readonly ran: readonly string[];
  /** Steps already recorded complete with the same input digest. */
  readonly skipped: readonly string[];
  readonly stoppedAt?: { readonly key: string; readonly reason: StopReason };
  /** Console reports that could not be delivered; the state store has them all. */
  readonly reportFailures: number;
}
