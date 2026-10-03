/**
 * Decides whether an already signature-verified token's claims belong to the
 * application presenting them, and names the tenant they bind it to.
 *
 * The signature, `kid` and algorithm are the JWT library's job and must be
 * checked first; nothing here reads an unverified token. What this adds is the
 * part a signature cannot say: that the token was issued to *this* application
 * rather than its sibling (by the `client_id` claim, since the audience lists
 * the whole project), that its issuer is the sign-in service, and that
 * the organisation it carries is the only source of a tenant.
 */

export const CLAIM_RESOURCE_OWNER = 'urn:zitadel:iam:user:resourceowner:id';
export const CLAIM_PROJECT_ROLES = 'urn:zitadel:iam:org:project:roles';

export type Claims = Readonly<Record<string, unknown>>;

export interface VerifierOptions {
  readonly issuer: string;
  /** The client id this application was issued. */
  readonly clientId: string;
  readonly requiredRole: string;
  /** Set for the owner console: the one organisation whose users may use it. */
  readonly requiredOrgId?: string;
  /** Seconds since the epoch; injected so expiry is testable. */
  readonly now: number;
  /** Tolerated clock skew in seconds. */
  readonly leewaySeconds?: number;
}

export type Verdict =
  | { readonly ok: true; readonly orgId: string; readonly subject: string }
  | { readonly ok: false; readonly reason: string };

const MAX_LEEWAY_SECONDS = 60;

function deny(reason: string): Verdict {
  return { ok: false, reason };
}

function audiences(claim: unknown): string[] | null {
  if (typeof claim === 'string') return [claim];
  if (Array.isArray(claim) && claim.every((value) => typeof value === 'string')) {
    return claim as string[];
  }
  return null;
}

/** Fails closed: any claim that is missing, mistyped or unexpected is a denial,
 * and the function never throws on hostile input. */
export function verifyClaims(claims: Claims, options: VerifierOptions): Verdict {
  const leeway = Math.min(Math.max(options.leewaySeconds ?? 0, 0), MAX_LEEWAY_SECONDS);

  if (claims['iss'] !== options.issuer) return deny('issuer is not the sign-in service');

  const aud = audiences(claims['aud']);
  if (aud === null) return deny('audience is missing or malformed');
  if (!aud.includes(options.clientId)) return deny('token was not issued to this application');
  // Zitadel lists every application of the project in `aud`, so the audience
  // cannot tell the two applications apart. The client the token was issued to
  // is the `client_id` claim.
  if (claims['client_id'] !== options.clientId)
    return deny('token was issued to a different application');

  const exp = claims['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return deny('expiry is missing');
  if (exp + leeway <= options.now) return deny('token has expired');
  const nbf = claims['nbf'];
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf - leeway > options.now)) {
    return deny('token is not yet valid');
  }

  const subject = claims['sub'];
  if (typeof subject !== 'string' || subject.length === 0) return deny('subject is missing');

  const orgId = claims[CLAIM_RESOURCE_OWNER];
  if (typeof orgId !== 'string' || orgId.length === 0) return deny('organisation is missing');
  if (options.requiredOrgId !== undefined && orgId !== options.requiredOrgId) {
    return deny('organisation is not permitted here');
  }

  const roles = claims[CLAIM_PROJECT_ROLES];
  if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) {
    return deny('roles are missing');
  }
  const holders = (roles as Record<string, unknown>)[options.requiredRole];
  if (typeof holders !== 'object' || holders === null || Array.isArray(holders)) {
    return deny(`role ${options.requiredRole} is missing`);
  }
  // A role is granted per organisation; it counts only for the organisation
  // the user belongs to, so a role granted to another organisation is not one.
  if (!Object.hasOwn(holders, orgId))
    return deny('role was not granted to the user’s organisation');

  return { ok: true, orgId, subject };
}
