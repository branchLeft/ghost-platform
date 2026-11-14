/**
 * Why a promotion step was refused or failed. The messages are fixed and never
 * carry what was posted or what the provisioning API answered, so the shell,
 * which logs only the error name, cannot leak either.
 */
export type PromotionRefusal =
  /** The signed-in tenant is not a demo: only a demo is promoted or asks about Professional. */
  | 'NOT_A_DEMO'
  /** The provisioning API refused the portal's own credential (401, 403) or the request itself (400). */
  | 'PROVISIONING_REFUSED'
  /** The provisioning API did not answer in time, or at all, or answered with a server error. */
  | 'PROVISIONING_UNREACHABLE'
  /** The provisioning API answered with something the contract does not allow for this call. */
  | 'UNEXPECTED_ANSWER'
  /** The tenant's own register row could not be read. */
  | 'READ_FAILED';

const MESSAGES: Readonly<Record<PromotionRefusal, string>> = {
  NOT_A_DEMO: 'the signed-in tenant is not a demo',
  PROVISIONING_REFUSED: 'the provisioning API refused the request',
  PROVISIONING_UNREACHABLE: 'the provisioning API could not be reached',
  UNEXPECTED_ANSWER: 'the provisioning API answered with something the contract does not allow',
  READ_FAILED: 'the tenant data needed for the request could not be read',
};

export class PromotionError extends Error {
  readonly reason: PromotionRefusal;

  /** `cause` is kept for a caller that wants it; the shell reports the error name only. */
  constructor(reason: PromotionRefusal, options?: { readonly cause: Error }) {
    super(MESSAGES[reason], options);
    this.name = 'PromotionError';
    this.reason = reason;
  }
}
