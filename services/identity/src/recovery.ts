import { createHash, randomInt } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { hostnameProblem } from './config.js';
import { OWNER_ORG_NAME } from './desired.js';

/** Owner recovery: the way back into the owner organisation when sign-in
 * itself is what is broken.
 *
 * It is a command run on the identity host, with nothing listening and nothing
 * remote about it. It talks to the sign-in service on a loopback address only,
 * with a recovery credential the owner staged a few minutes ago, which it
 * consumes on first read. It never touches the portal, the console or any page
 * behind the sign-in service's own login. Every attempt, refused or not, is
 * written to an audit file first. */

export const DEFAULT_MAX_CREDENTIAL_AGE_SECONDS = 1800;
export const MAX_CREDENTIAL_AGE_SECONDS = 3600;

export type RefusalCode =
  | 'not-loopback'
  | 'bad-instance-host'
  | 'bad-user-id'
  | 'bad-max-age'
  | 'not-a-terminal'
  | 'credential-missing'
  | 'credential-not-regular'
  | 'credential-owner'
  | 'credential-mode'
  | 'credential-stale'
  | 'credential-future'
  | 'credential-empty'
  | 'audit-unwritable'
  | 'consume-failed'
  | 'wrong-organisation'
  | 'not-human'
  | 'api-error';

/** A refusal carries a fixed code and a fixed sentence, never a value taken
 * from the credential, the response or the request. */
export class RecoveryRefused extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = 'RecoveryRefused';
    this.code = code;
  }
}

export type RecoveryFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    /** Always `error`: a loopback request that is redirected somewhere else
     * must fail rather than carry the credential with it. */
    redirect: 'error';
  }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RecoveryOptions {
  /** Loopback origin of the sign-in service, e.g. `http://127.0.0.1:8080`. */
  readonly baseUrl: string;
  /** The instance's public sign-in name. Zitadel picks the instance from it,
   * and a loopback request does not otherwise carry it. */
  readonly instanceHost: string;
  readonly userId: string;
  readonly credentialFile: string;
  readonly auditFile: string;
  readonly maxCredentialAgeSeconds?: number;
}

export interface RecoveryDeps {
  readonly fetch: RecoveryFetch;
  readonly now: () => Date;
  /** Uid the process runs as; the credential file must be owned by it. */
  readonly uid: number;
  readonly actor: string;
  /** The one-time password is shown on a terminal and nowhere else, so a pipe,
   * a log or a captured session never holds it. */
  readonly stdoutIsTerminal: boolean;
}

export interface RecoveryResult {
  readonly oneTimePassword: string;
  readonly actions: readonly string[];
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]']);
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Returns the origin to call, or refuses. Parsed, not pattern-matched, so
 * `http://127.0.0.1@elsewhere`, `http://127.0.0.1.elsewhere` and a name that
 * merely resolves to loopback are all refused. */
export function loopbackOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RecoveryRefused('not-loopback', 'the sign-in address is not a loopback address');
  }
  const plain =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '';
  if (!plain || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new RecoveryRefused('not-loopback', 'the sign-in address is not a loopback address');
  }
  return url.origin;
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

interface AuditEntry {
  readonly event: 'recovery.begin' | 'recovery.end';
  readonly user: string;
  readonly credential?: string;
  readonly outcome?: string;
}

function appendAudit(options: RecoveryOptions, deps: RecoveryDeps, entry: AuditEntry): void {
  const line = `${JSON.stringify({
    at: deps.now().toISOString(),
    actor: deps.actor,
    ...entry,
  })}\n`;
  let fd: number;
  try {
    // O_NOFOLLOW so a planted symlink cannot redirect the record elsewhere.
    fd = openSync(
      options.auditFile,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600
    );
  } catch {
    throw new RecoveryRefused('audit-unwritable', 'the audit file cannot be opened for appending');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new RecoveryRefused(
        'audit-unwritable',
        'the audit file must be a regular file closed to everyone else'
      );
    }
    appendFileSync(fd, line);
  } catch (error) {
    if (error instanceof RecoveryRefused) throw error;
    throw new RecoveryRefused('audit-unwritable', 'the audit file cannot be written');
  } finally {
    closeSync(fd);
  }
}

interface StagedCredential {
  readonly token: string;
  readonly dev: number;
  readonly ino: number;
}

/** Reads the staged credential through one open file descriptor: opened
 * without following a link, then every check (type, owner, mode, age) and the
 * read are made on that descriptor, so a path swapped after the open cannot
 * change what was checked. A stale copy is refused so a forgotten file is
 * useless rather than a standing way in. */
function readStagedCredential(options: RecoveryOptions, deps: RecoveryDeps): StagedCredential {
  const maxAge = options.maxCredentialAgeSeconds ?? DEFAULT_MAX_CREDENTIAL_AGE_SECONDS;
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > MAX_CREDENTIAL_AGE_SECONDS) {
    throw new RecoveryRefused(
      'bad-max-age',
      `the credential age limit must be a whole number of seconds from 1 to ${MAX_CREDENTIAL_AGE_SECONDS}`
    );
  }
  let fd: number;
  try {
    fd = openSync(options.credentialFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new RecoveryRefused('credential-missing', 'the staged credential file does not exist');
    }
    throw new RecoveryRefused(
      'credential-not-regular',
      'the staged credential must be a regular file, not a link or a directory'
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new RecoveryRefused(
        'credential-not-regular',
        'the staged credential must be a regular file, not a link or a directory'
      );
    }
    if (stat.uid !== deps.uid) {
      throw new RecoveryRefused(
        'credential-owner',
        'the staged credential is owned by another user'
      );
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new RecoveryRefused(
        'credential-mode',
        'the staged credential must be readable by its owner only'
      );
    }
    const ageSeconds = (deps.now().getTime() - stat.mtimeMs) / 1000;
    if (ageSeconds < 0) {
      throw new RecoveryRefused(
        'credential-future',
        'the staged credential is dated in the future'
      );
    }
    if (ageSeconds > maxAge) {
      throw new RecoveryRefused(
        'credential-stale',
        'the staged credential is older than the age limit; stage it again'
      );
    }
    const token = readFileSync(fd, 'utf8').trim();
    if (token.length === 0) {
      throw new RecoveryRefused('credential-empty', 'the staged credential file is empty');
    }
    return { token, dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

/** Removes the staged file only if the path still names the file that was
 * read, so a swap after the read cannot make this delete something else. */
function consumeStagedCredential(path: string, staged: StagedCredential): void {
  try {
    const now = lstatSync(path);
    if (!now.isFile() || now.dev !== staged.dev || now.ino !== staged.ino)
      throw new Error('swapped');
    unlinkSync(path);
  } catch {
    throw new RecoveryRefused(
      'consume-failed',
      'the staged credential could not be removed, so it cannot be single-use'
    );
  }
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const SYMBOL = '-_.!#%+=';

/** A one-time password drawn from the system's random source, with one of each
 * character class so it passes Zitadel's default complexity policy. The sign-in
 * service is told to demand a change at first use. */
export function generateOneTimePassword(length = 24): string {
  const pools = [LOWER, UPPER, DIGIT, SYMBOL];
  const all = pools.join('');
  const chars: string[] = pools.map((pool) => pool[randomInt(pool.length)] as string);
  while (chars.length < length) chars.push(all[randomInt(all.length)] as string);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

async function api(
  options: RecoveryOptions,
  deps: RecoveryDeps,
  origin: string,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Json> {
  let response;
  try {
    response = await deps.fetch(`${origin}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'x-zitadel-instance-host': options.instanceHost,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
    });
  } catch {
    throw new RecoveryRefused('api-error', `the sign-in service could not be reached for ${path}`);
  }
  if (!response.ok) {
    throw new RecoveryRefused(
      'api-error',
      `the sign-in service answered ${response.status} for ${path}`
    );
  }
  const parsed = asRecord(await response.json().catch(() => null));
  if (!parsed)
    throw new RecoveryRefused('api-error', `the answer for ${path} was not a JSON object`);
  return parsed;
}

/** Restores the owner's way in: unlocks or reactivates the named owner-
 * organisation user if it is locked or inactive, and sets a one-time password
 * that must be changed at first sign-in. Refuses, with a fixed code, whenever
 * a condition is not met. The audit file is written before the credential is
 * consumed and again at the end, whatever the outcome. */
export async function recoverOwner(
  options: RecoveryOptions,
  deps: RecoveryDeps
): Promise<RecoveryResult> {
  // Written first and fail-closed: a refusal of any kind leaves a begin and an
  // end line, and nothing is checked, read or changed if the first cannot be written.
  const user = options.userId.slice(0, 64);
  appendAudit(options, deps, { event: 'recovery.begin', user });
  let credential: string | undefined;
  let outcome = 'recovered';
  try {
    const origin = loopbackOrigin(options.baseUrl);
    if (hostnameProblem('instanceHost', options.instanceHost) !== null) {
      throw new RecoveryRefused('bad-instance-host', 'the instance host is not a plain DNS name');
    }
    if (!USER_ID.test(options.userId)) {
      throw new RecoveryRefused('bad-user-id', 'the user id is not a plain identifier');
    }
    if (!deps.stdoutIsTerminal) {
      throw new RecoveryRefused(
        'not-a-terminal',
        'the one-time password is shown on a terminal only; run this from an interactive session'
      );
    }
    const staged = readStagedCredential(options, deps);
    const token = staged.token;
    credential = fingerprint(token);
    consumeStagedCredential(options.credentialFile, staged);
    const actions: string[] = [];
    const org = asRecord(
      (await api(options, deps, origin, token, 'GET', '/management/v1/orgs/me'))['org']
    );
    if (!org || org['name'] !== OWNER_ORG_NAME || typeof org['id'] !== 'string') {
      throw new RecoveryRefused(
        'wrong-organisation',
        'the credential does not belong to the owner organisation'
      );
    }
    const found = asRecord(
      (await api(options, deps, origin, token, 'GET', `/v2/users/${options.userId}`))['user']
    );
    const details = asRecord(found?.['details']);
    if (!found || !details || details['resourceOwner'] !== org['id']) {
      throw new RecoveryRefused('wrong-organisation', 'the user is not in the owner organisation');
    }
    if (asRecord(found['human']) === null) {
      throw new RecoveryRefused('not-human', 'the user is not a person');
    }
    if (found['state'] === 'USER_STATE_LOCKED') {
      await api(
        options,
        deps,
        origin,
        token,
        'POST',
        `/management/v1/users/${options.userId}/_unlock`,
        {}
      );
      actions.push('unlocked');
    } else if (found['state'] === 'USER_STATE_INACTIVE') {
      await api(
        options,
        deps,
        origin,
        token,
        'POST',
        `/management/v1/users/${options.userId}/_reactivate`,
        {}
      );
      actions.push('reactivated');
    }
    const oneTimePassword = generateOneTimePassword();
    await api(options, deps, origin, token, 'POST', `/v2/users/${options.userId}/password`, {
      newPassword: { password: oneTimePassword, changeRequired: true },
    });
    actions.push('password-set');
    return { oneTimePassword, actions };
  } catch (error) {
    outcome = error instanceof RecoveryRefused ? error.code : 'failed';
    throw error;
  } finally {
    try {
      appendAudit(options, deps, {
        event: 'recovery.end',
        user,
        ...(credential === undefined ? {} : { credential }),
        outcome,
      });
    } catch {
      // The begin entry is already on record; a failed closing entry must not
      // mask the outcome the caller is about to see.
    }
  }
}
