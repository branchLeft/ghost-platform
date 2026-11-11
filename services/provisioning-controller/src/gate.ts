import { ApprovalRequiredError, ApprovalScopeError } from './errors.js';
import type { ApprovalLedger, ApprovalScope, RecordedApproval } from './ports.js';

/**
 * The approval gate. The executor calls it before the run and again before
 * every attempt of every step. A step runs while its own scope stands: a
 * withdrawn scope stops the run at the first step that needs it, and a revoked
 * or re-pointed approval stops it at the next step. Steps in scopes still
 * granted continue.
 */
export async function assertApproval(
  approvalId: string,
  ledger: ApprovalLedger,
  scopes: readonly ApprovalScope[],
  tenantId?: string
): Promise<RecordedApproval> {
  const approval = await ledger.find(approvalId);
  if (approval === undefined) throw new ApprovalRequiredError(approvalId);
  if (tenantId !== undefined && approval.tenantId !== tenantId) {
    throw new ApprovalRequiredError(approvalId);
  }
  const missing = scopes.filter((s) => !approval.scopes.includes(s));
  if (missing.length > 0) throw new ApprovalScopeError(approvalId, missing);
  return approval;
}
