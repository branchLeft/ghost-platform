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
  /**
   * The tenant's opaque prefix in the shared state bucket: a random
   * identifier, never the slug, assigned once and never reissued. The tenant's
   * state credential is confined to it by the gateway.
   */
  readonly stateFolder: string;
  readonly mediaBucket: string;
  readonly appHostSlot: string;
  readonly appHostPort: number;
  readonly appHostUid: number;
  /** Empty for a private slot with no public name; the steps that need one are then not applicable. */
  readonly hostnames: readonly string[];
  /** Whether the tenant sends mail. Absent means yes; `false` makes the mail DNS step not applicable. */
  readonly mail?: boolean;
  /**
   * Where media credentials come from. Absent or `gateway`: the storage gateway mints them.
   * `s3`: the tenant boots on placeholder values and the gateway's two mints are not applicable.
   */
  readonly mediaMode?: MediaMode;
  /** Whether backups are enrolled. Absent means yes; `false` makes the backup step not applicable. */
  readonly backups?: boolean;
  /**
   * The image the first deploy pins, as `sha256:` and 64 hex digits. Assigned by the register, never
   * typed at a run; the first deploy is refused without it.
   */
  readonly imageDigest?: string;
}

export const MEDIA_MODES = ['gateway', 's3'] as const;
export type MediaMode = (typeof MEDIA_MODES)[number];

export interface TenantRegisterReader {
  read(tenantId: string): Promise<RegisterEntry | undefined>;
}

export interface PlanPorts {
  readonly approvals: ApprovalLedger;
  readonly register: TenantRegisterReader;
}
