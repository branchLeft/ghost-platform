import {
  ApprovalRequiredError,
  ApprovalScopeError,
  RegisterEntryInvalidError,
  RegisterEntryMissingError,
} from './errors.js';
import { buildSteps, type OnboardingPlan } from './plan.js';
import { APPROVAL_SCOPES, type PlanPorts } from './ports.js';
import { invalidFields } from './validate.js';

/**
 * The only way a plan exists. The approval id is the sole argument that
 * names work: the tenant comes from the recorded approval and every input
 * from the register, so a caller cannot steer a step. Reads only; executing,
 * retrying and recording state belong to whatever consumes the plan.
 */
export async function planOnboarding(
  approvalId: string,
  ports: PlanPorts
): Promise<OnboardingPlan> {
  const approval = await ports.approvals.find(approvalId);
  if (approval === undefined) throw new ApprovalRequiredError(approvalId);

  const missing = APPROVAL_SCOPES.filter((s) => !approval.scopes.includes(s));
  if (missing.length > 0) throw new ApprovalScopeError(approvalId, missing);

  const entry = await ports.register.read(approval.tenantId);
  if (entry === undefined || entry.tenantId !== approval.tenantId) {
    throw new RegisterEntryMissingError(approval.tenantId);
  }
  const bad = invalidFields(entry);
  if (bad.length > 0) throw new RegisterEntryInvalidError(entry.tenantId, bad);

  return { approvalId, tenantId: entry.tenantId, steps: buildSteps(entry) };
}
