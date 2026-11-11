/**
 * The two reads the planner depends on. Both are ports, not stores: the
 * tenant register's authoritative schema lives in the portal data package,
 * which this service cannot import (it is not published), so the controller
 * sees only the narrow shape onboarding needs and a deployment adapts the
 * real register to it. Nothing here writes.
 */

/** What one approval covers: setup, the web address and the first deploy. */
export const APPROVAL_SCOPES = ['setup', 'web-address', 'first-deploy'] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/** A decision the owner recorded in the console. The approval id is the only trigger. */
export interface RecordedApproval {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly approvedAt: string;
  readonly scopes: readonly ApprovalScope[];
}

export interface ApprovalLedger {
  /** Resolves the recorded approval, or undefined when none is on record. */
  find(approvalId: string): Promise<RecordedApproval | undefined>;
}

/** One tenant's onboarding facts, as the register holds them. Assigned and recorded, never computed here. */
export interface RegisterEntry {
  readonly tenantId: string;
  readonly mediaFolder: string;
  readonly mediaBucket: string;
  readonly appHostSlot: string;
  readonly appHostPort: number;
  readonly appHostUid: number;
  readonly hostnames: readonly string[];
}

export interface TenantRegisterReader {
  read(tenantId: string): Promise<RegisterEntry | undefined>;
}

export interface PlanPorts {
  readonly approvals: ApprovalLedger;
  readonly register: TenantRegisterReader;
}
