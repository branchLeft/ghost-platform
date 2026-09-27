/**
 * An export is a support grant (LLD-5 §05's two lanes). The grant itself --
 * un-suspending the support account, and re-suspending it afterwards -- is
 * done by a person: the tenant in their own Staff screen (consented lane),
 * or the operator on the tenant host (incident lane). This package takes
 * the grant as input and checks that it is real; it has no code path that
 * writes the account's status.
 */

export type GrantLane = 'consented' | 'incident';

export interface SupportGrant {
  readonly lane: GrantLane;
  /** Where the grant's evidence lives: the incident request, or the tenant's own activity-log entry. */
  readonly reference: string;
}

export class NoSupportGrantError extends Error {
  constructor(detail: string) {
    super(`refused: no support grant in force (${detail}); nothing was started`);
    this.name = 'NoSupportGrantError';
  }
}

export class SupportAccountNotActiveError extends Error {
  constructor(
    readonly identity: string,
    readonly status: string | null
  ) {
    super(
      status === null
        ? `refused: support account ${identity} does not exist on this tenant; nothing was started`
        : `refused: support account ${identity} is not active (status "${status}") -- it is un-suspended only through a grant lane, never by this tool; nothing was started`
    );
    this.name = 'SupportAccountNotActiveError';
  }
}

const LANES: readonly GrantLane[] = ['consented', 'incident'];
// One printable line: it is written verbatim into the audit record.
const REFERENCE = /^[\x21-\x7e][\x20-\x7e]{0,199}$/;

export function parseSupportGrant(
  lane: string | undefined,
  reference: string | undefined
): SupportGrant {
  if (lane === undefined || !(LANES as readonly string[]).includes(lane)) {
    throw new NoSupportGrantError(`grant lane must be one of ${LANES.join(', ')}`);
  }
  if (reference === undefined || !REFERENCE.test(reference)) {
    throw new NoSupportGrantError('grant reference must be one printable line of 1-200 characters');
  }
  return { lane: lane as GrantLane, reference };
}

/**
 * Ghost's own active states (`activeStates` in core/server/models/user.js),
 * the same test Ghost's session lookup and the break-glass adapter apply.
 * Anything else, including a status this list has never seen, is refused.
 */
export const GHOST_ACTIVE_STATES: readonly string[] = [
  'active',
  'warn-1',
  'warn-2',
  'warn-3',
  'warn-4',
];

export function assertSupportAccountActive(identity: string, status: string | null): void {
  if (status === null || !GHOST_ACTIVE_STATES.includes(status)) {
    throw new SupportAccountNotActiveError(identity, status);
  }
}

export class NotTheSupportAccountError extends Error {
  constructor(
    readonly identity: string,
    readonly roles: readonly string[]
  ) {
    super(
      `refused: ${identity} is not the support account -- its roles are [${roles.join(', ')}], ` +
        `and only an account holding exactly the Administrator role qualifies; nothing was started`
    );
    this.name = 'NotTheSupportAccountError';
  }
}

/**
 * The account the export's session will belong to must be the support
 * Administrator: never the Owner, whose account is never suspended and so
 * would pass the status check with no grant open, and never any other
 * staff role.
 */
export function assertIsSupportRole(identity: string, roles: readonly string[]): void {
  if (roles.length !== 1 || roles[0] !== 'Administrator') {
    throw new NotTheSupportAccountError(identity, roles);
  }
}

export interface SupportAccount {
  readonly status: string;
  readonly roles: readonly string[];
}

/** Reads the support account from the tenant's own database; null when absent. */
export interface SupportAccountStatusReader {
  readAccount(identity: string): Promise<SupportAccount | null>;
}
