import type { MailClass } from './sendingTarget.js';

/**
 * The mx1 outbound lane of a message: `nl` is the newsletter lane, `tx` the
 * transactional one. mx1's MTA chooses the source IP by the envelope sender's
 * domain, so the lane is carried as the domain of the return path. See
 * ../README.md#lane-return-paths.
 */
export type Mx1Lane = 'tx' | 'nl';

/** The envelope sender of each lane. The two must be on different domains. */
export interface Mx1LaneReturnPaths {
  tx: string;
  nl: string;
}

export const MX1_TX_RETURN_PATH_ENV = 'COLLECTOR_MX1_TX_RETURN_PATH';
export const MX1_NL_RETURN_PATH_ENV = 'COLLECTOR_MX1_NL_RETURN_PATH';

/**
 * The one place a mx1 message's lane is decided. Every newsletter, and all
 * demo mail (sign-in links included), rides the newsletter lane; only a
 * non-demo sign-in message rides the transactional one.
 */
export function mx1Lane(mailClass: MailClass, demo: boolean): Mx1Lane {
  return mailClass === 'bulk' || demo ? 'nl' : 'tx';
}

export function laneReturnPath(
  paths: Mx1LaneReturnPaths,
  mailClass: MailClass,
  demo: boolean
): string {
  return paths[mx1Lane(mailClass, demo)];
}

// A bare addr-spec: no display name, no angle brackets, no list, no spaces; a
// dotted domain of letters, digits and inner hyphens.
const PLAIN_ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * Both set or neither; each a plain address; the two on different domains,
 * because the MTA tells the lanes apart by sender domain and one shared domain
 * would send everything one way without any error. Throws at start-up.
 */
export function parseLaneReturnPaths(
  tx: string | undefined,
  nl: string | undefined
): Mx1LaneReturnPaths | undefined {
  if (!tx && !nl) {
    return undefined;
  }
  if (!tx || !nl) {
    throw new Error(`${MX1_TX_RETURN_PATH_ENV} and ${MX1_NL_RETURN_PATH_ENV} must be set together`);
  }
  for (const [name, value] of [
    [MX1_TX_RETURN_PATH_ENV, tx],
    [MX1_NL_RETURN_PATH_ENV, nl],
  ] as const) {
    if (!PLAIN_ADDRESS.test(value)) {
      throw new Error(`${name} must be a plain address (name@domain), with no name or brackets`);
    }
  }
  if (domainOf(tx) === domainOf(nl)) {
    throw new Error(
      `${MX1_TX_RETURN_PATH_ENV} and ${MX1_NL_RETURN_PATH_ENV} must be on different domains: mx1 tells the lanes apart by sender domain`
    );
  }
  return { tx, nl };
}
