import { ApprovalRequiredError, ApprovalScopeError } from './errors.js';
import type { ApprovalLedger, ApprovalScope, RecordedApproval } from './ports.js';

/**
 * The approval gate. The executor calls it once before the run, with all three
 * scopes, and again before every attempt of each step that runs, with that
 * step's scope alone. A scope is withdrawn when the recorded approval no longer
 * lists it, and a narrowed approval is the same thing. Before the run, one
 * withdrawn scope refuses the whole run before any step. During the run, the
 * check at the next attempt of a step that needs the withdrawn scope throws, and
 * the steps after that one do not run in that call, even those in scopes still
 * granted. An approval that is revoked, or re-pointed at another tenant, is
 * refused at the next check. Before the run there is no tenant to compare, so
 * the run takes the tenant the ledger names when it starts.
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
