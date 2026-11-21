import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Credentials } from './auth.js';

/** A credential shorter than this is refused as not configured: it is guessable. */
export const MIN_CREDENTIAL_LENGTH = 16;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why the credentials cannot be used. A code only, never a value. */
export type CredentialProblem =
  | 'owner-credential-unreadable'
  | 'owner-credential-too-short'
  | 'tenant-credentials-unreadable'
  | 'tenant-credentials-malformed'
  | 'tenant-credentials-empty'
  | 'credentials-not-distinct';

type Parsed =
  | { readonly ok: true; readonly credentials: Credentials }
  | { readonly ok: false; readonly problem: CredentialProblem };

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parse(ownerFile: string, tenantsFile: string): Parsed {
  const ownerRaw = read(ownerFile);
  if (ownerRaw === undefined) return { ok: false, problem: 'owner-credential-unreadable' };
  const owner = ownerRaw.trim();
  if (owner.length < MIN_CREDENTIAL_LENGTH) {
    return { ok: false, problem: 'owner-credential-too-short' };
  }
  const tenantsRaw = read(tenantsFile);
  if (tenantsRaw === undefined) return { ok: false, problem: 'tenant-credentials-unreadable' };
  const tenants = new Map<string, string>();
  const issuedTo = new Set<string>();
  for (const line of tenantsRaw.split('\n')) {
    const entry = line.trim();
    if (entry === '') continue;
    const at = entry.indexOf('=');
    const tenant = entry.slice(0, at);
    const value = entry.slice(at + 1);
    if (at < 0 || !UUID.test(tenant) || value.length < MIN_CREDENTIAL_LENGTH) {
      return { ok: false, problem: 'tenant-credentials-malformed' };
    }
    if (issuedTo.has(tenant) || tenants.has(value) || value === owner) {
      return { ok: false, problem: 'credentials-not-distinct' };
    }
    tenants.set(value, tenant);
    issuedTo.add(tenant);
  }
  if (tenants.size === 0) return { ok: false, problem: 'tenant-credentials-empty' };
  return { ok: true, credentials: { owner, tenants } };
}

/**
 * The two credential files, read again on every use, so a credential the owner
 * places or changes takes effect without a restart. Anything wrong with either
 * file leaves no credential that anyone can present: every call is refused
 * `unauthenticated`, and `onProblem` is told the code once for each change of
 * problem. The stand-in owner value is random per process and never leaves it.
 */
export function fileCredentials(
  ownerFile: string,
  tenantsFile: string,
  onProblem: (problem: CredentialProblem | undefined) => void
): Credentials {
  const nobody: Credentials = { owner: randomBytes(32).toString('hex'), tenants: new Map() };
  let last: CredentialProblem | undefined;
  const current = (): Credentials => {
    const parsed = parse(ownerFile, tenantsFile);
    const problem = parsed.ok ? undefined : parsed.problem;
    if (problem !== last) {
      last = problem;
      onProblem(problem);
    }
    return parsed.ok ? parsed.credentials : nobody;
  };
  return {
    get owner() {
      return current().owner;
    },
    get tenants() {
      return current().tenants;
    },
  };
}
