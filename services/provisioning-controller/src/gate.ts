import { ApprovalRequiredError, ApprovalScopeError } from './errors.js';
import type { ApprovalLedger, ApprovalScope, RecordedApproval } from './ports.js';

/**
 * The approval gate. The executor calls it before the run and again before
 * every attempt of every step, so an approval that is revoked, narrowed or
 * re-pointed at another tenant stops the work at the next step boundary.
 */
export async function assertApproval(
  approvalId: string,
  ledger: ApprovalLedger,
  scopes: readonly ApprovalScope[],
  tenantId?: string
): Promise<RecordedApproval> {
  const approval = await ledger.find(approvalId);
  if (approval === undefined || approval.approvalId !== approvalId) {
    throw new ApprovalRequiredError(approvalId);
  }
  if (tenantId !== undefined && approval.tenantId !== tenantId) {
    throw new ApprovalRequiredError(approvalId);
  }
  const missing = scopes.filter((s) => !approval.scopes.includes(s));
  if (missing.length > 0) throw new ApprovalScopeError(approvalId, missing);
  return approval;
}
