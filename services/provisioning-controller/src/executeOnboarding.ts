import {
  ApprovalRequiredError,
  ApprovalScopeError,
  PermanentStepError,
  StateStoreUnreadableError,
  StateStoreWriteError,
} from './errors.js';
import type {
  ExecutePorts,
  ProgressEvent,
  RunOptions,
  RunResult,
  StateRecord,
  StopReason,
} from './executePorts.js';
import { assertApproval } from './gate.js';
import { orderSteps } from './order.js';
import { planOnboarding } from './planOnboarding.js';
import type { PlannedStep } from './plan.js';
import { APPROVAL_SCOPES, type ApprovalScope } from './ports.js';
import { delayFor, resolveRetry } from './retry.js';
import { completedDigests } from './state.js';

const describeError = (e: unknown): string => {
  const name = e instanceof Error ? e.name : 'Error';
  const message = e instanceof Error ? e.message : String(e);
  return `${name}: ${message}`.replace(/\p{Cc}+/gu, ' ').slice(0, 200);
};

/**
 * Carries out the plan for one approval. Each call is a fresh start or a
 * resume: it re-checks the approval, reads the recorded history (and runs
 * nothing if that cannot be read), and then walks the steps in dependency
 * order. A step recorded complete under the same digest is skipped; under a
 * different digest the run stops and says so. Every outcome is appended to
 * the state store before the next step begins, and reported afterwards.
 */
export async function executeOnboarding(
  approvalId: string,
  ports: ExecutePorts,
  options: RunOptions = {}
): Promise<RunResult> {
  const retry = resolveRetry(options.retry);
  let tenantId: string | undefined;
  let reportFailures = 0;

  const record = async (
    event: StateRecord['event'],
    extra: Partial<Omit<StateRecord, 'at' | 'approvalId' | 'event'>> = {}
  ): Promise<void> => {
    try {
      await ports.state.append({ at: ports.clock.now(), approvalId, event, ...extra });
    } catch (cause) {
      throw new StateStoreWriteError(cause);
    }
  };

  const emit = async (
    type: ProgressEvent['type'],
    extra: Partial<Omit<ProgressEvent, 'type' | 'at' | 'approvalId'>> = {}
  ): Promise<void> => {
    const event: ProgressEvent = {
      type,
      at: ports.clock.now(),
      approvalId,
      ...(tenantId !== undefined && { tenantId }),
      ...extra,
    };
    try {
      await ports.console.report(event);
    } catch {
      reportFailures += 1;
    }
  };

  const guard = async (scopes: readonly ApprovalScope[]): Promise<void> => {
    try {
      await assertApproval(approvalId, ports.approvals, scopes, tenantId);
    } catch (e) {
      if (e instanceof ApprovalRequiredError || e instanceof ApprovalScopeError) {
        await record('run-halted', { reason: e.message });
        await emit('run-halted', { reason: e.message });
      }
      throw e;
    }
  };

  const runStep = async (step: PlannedStep): Promise<boolean> => {
    const common = { key: step.key, inputDigest: step.inputDigest };
    for (let attempt = 1; ; attempt += 1) {
      await guard([step.scope]);
      if (attempt === 1) {
        await record('started', { ...common, attempt });
        await emit('step-started', { key: step.key, attempt });
      }
      try {
        await ports.hosts[step.entryPoint].run({
          key: step.key,
          id: step.id,
          idempotencyKey: `${step.key}@${step.inputDigest}`,
          inputs: step.inputs,
        });
      } catch (e) {
        const reason = describeError(e);
        if (attempt >= retry.maxAttempts || e instanceof PermanentStepError) {
          await record('step-failed', { ...common, attempt, reason });
          await emit('step-failed', { key: step.key, attempt, reason });
          return false;
        }
        const delayMs = delayFor(attempt, retry);
        await record('attempt-failed', { ...common, attempt, reason });
        await emit('step-retrying', { key: step.key, attempt, delayMs, reason });
        await ports.clock.sleep(delayMs);
        continue;
      }
      await record('complete', { ...common, attempt });
      await emit('step-complete', { key: step.key, attempt });
      return true;
    }
  };

  await guard(APPROVAL_SCOPES);

  let history: readonly StateRecord[];
  try {
    history = await ports.state.readAll();
  } catch (cause) {
    throw new StateStoreUnreadableError(cause);
  }
  const done = completedDigests(history);

  const plan = await planOnboarding(approvalId, ports);
  tenantId = plan.tenantId;
  const ordered = orderSteps(plan.steps);

  const ran: string[] = [];
  const skipped: string[] = [];
  const result = (stoppedAt?: { key: string; reason: StopReason }): RunResult => ({
    status: stoppedAt === undefined ? 'complete' : 'stopped',
    approvalId,
    tenantId: plan.tenantId,
    ran,
    skipped,
    ...(stoppedAt !== undefined && { stoppedAt }),
    reportFailures,
  });

  await emit('run-started', { reason: done.size > 0 ? 'resumed' : 'fresh' });

  for (const step of ordered) {
    const recorded = done.get(step.key);
    if (recorded === step.inputDigest) {
      skipped.push(step.key);
      await emit('step-skipped', { key: step.key });
      continue;
    }
    if (recorded !== undefined) {
      const reason = `recorded complete under a different input digest (${recorded.slice(0, 12)}, now ${step.inputDigest.slice(0, 12)})`;
      await record('digest-mismatch', { key: step.key, inputDigest: step.inputDigest, reason });
      await emit('step-refused', { key: step.key, reason });
      return result({ key: step.key, reason: 'input-changed' });
    }
    if (!(await runStep(step))) return result({ key: step.key, reason: 'step-failed' });
    ran.push(step.key);
  }

  await record('run-complete');
  await emit('run-complete');
  return result();
}
