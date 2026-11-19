import { randomBytes } from 'node:crypto';
import { resolveBodyCeiling } from '../body.js';
import { credentialProfile, type CredentialProfile, type CredentialRecord } from '../contracts.js';
import { authenticateAdmin, type AdminAuthDeps, type AdminCaller } from './adminAuth.js';
import { deriveTenantSecret } from './derive.js';
import type { MasterSecret } from './masterSecret.js';
import type { SqliteCredentialStore, StoredCredential } from './store.js';

/** One admin request, transport-neutral: the HTTP listener adapts to this. */
export interface AdminRequest {
  readonly method: string;
  /** The path only, no query string. */
  readonly path: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: Buffer;
}

export interface AdminResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The most a mint may set as a tenant's upload ceiling, in MiB (5 GiB). It is
 * a sanity bound against a typo or an unbounded value, not a tier value: the
 * per-tier ceilings are the owner's and the provisioning controller passes
 * them on each mint.
 */
export const MAX_UPLOAD_CEILING_MIB = 5 * 1024;

export type AdminOperation = 'mint' | 'disable' | 'disable-folder' | 'state';

/**
 * Which caller may do what. The erasure job disables and reads state as the
 * first step of an erasure; it never mints. The controller disables by
 * folder to recover from a mint whose answer it lost. Anything absent is
 * refused.
 */
export const ADMIN_PERMISSIONS: Readonly<Record<AdminCaller, readonly AdminOperation[]>> = {
  'provisioning-controller': ['mint', 'disable', 'disable-folder', 'state'],
  'erasure-job': ['disable', 'disable-folder', 'state'],
};

/** The operations that change credentials, and so are logged. */
export type LoggedAdminOperation = Exclude<AdminOperation, 'state'>;

/** One logged admin operation. Carries no secret and is written only after the change succeeded. */
export interface AdminLogEntry {
  readonly event: 'admin-operation';
  readonly caller: AdminCaller;
  readonly operation: LoggedAdminOperation;
  /** ISO time of the operation: the same value stored as `disabled_at` or `created_at`. */
  readonly at: string;
  /** Present for mint and disable. */
  readonly keyId?: string;
  readonly folder: string;
  /** Credentials moved to disabled, so 0 for a repeat. Absent for mint. */
  readonly changed?: number;
}

export interface AdminLogger {
  admin(entry: AdminLogEntry): void;
}

export interface AdminDeps {
  readonly auth: AdminAuthDeps;
  readonly store: Pick<
    SqliteCredentialStore,
    'insert' | 'disable' | 'get' | 'disableFolder' | 'listByFolder'
  >;
  readonly master: MasterSecret;
  /**
   * Which credentials this instance mints. `media` (the default) mints the
   * media credentials the media process serves. `state` mints a tenant's
   * state credential, which names only its own prefix: the instance is the
   * state process's, and its `master` is the state master secret, never the
   * media one.
   */
  readonly profile?: CredentialProfile;
  /** The state shard's bucket, which every state credential names. Required when `profile` is `state`, and refused otherwise. */
  readonly stateBucket?: string;
  readonly logger: AdminLogger;
  /** Defaults to {@link newKeyId}; injected by tests. */
  readonly newKeyId?: () => string;
}

// Upper-case letters and digits, 32 symbols so a random byte maps evenly.
const KEY_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const KEY_ID_PREFIX = 'GW';
const KEY_ID_RANDOM_CHARS = 24;

/** A fresh random key id: `GW` then 24 symbols, 120 bits of randomness. */
export function newKeyId(): string {
  const bytes = randomBytes(KEY_ID_RANDOM_CHARS);
  let id = KEY_ID_PREFIX;
  for (const byte of bytes) id += KEY_ID_ALPHABET[byte & 31];
  return id;
}

const FOLDER_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BUCKET_PATTERN = /^(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY_ID_IN_PATH = '([A-Z0-9]{16,64})';
const STATE_ROUTE = new RegExp(`^/credentials/${KEY_ID_IN_PATH}$`);
const DISABLE_ROUTE = new RegExp(`^/credentials/${KEY_ID_IN_PATH}/disable$`);
const DISABLE_FOLDER_ROUTE = /^\/folders\/([A-Za-z0-9_-]{16,128})\/disable$/;

// Every answer is uncacheable: one of them carries a secret, and a cache in
// between must never get the chance to keep it.
const RESPONSE_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function respond(status: number, body: object): AdminResponse {
  return { status, headers: RESPONSE_HEADERS, body: JSON.stringify(body) };
}

function describe(credential: StoredCredential): object {
  return {
    keyId: credential.keyId,
    folder: credential.folder,
    bucket: credential.bucket,
    profile: credentialProfile(credential) ?? 'media',
    state: credential.state,
    createdAt: credential.createdAt,
    ...(credential.uploadCeilingMib === undefined
      ? {}
      : { uploadCeilingMib: credential.uploadCeilingMib }),
  };
}

type Routed =
  | { readonly op: 'mint' }
  | { readonly op: 'disable' | 'state'; readonly keyId: string }
  | { readonly op: 'disable-folder'; readonly folder: string }
  | undefined;

function route(method: string, path: string): Routed {
  if (method === 'POST' && path === '/credentials') return { op: 'mint' };
  const disable = DISABLE_ROUTE.exec(path);
  if (method === 'POST' && disable) return { op: 'disable', keyId: disable[1]! };
  const disableFolder = DISABLE_FOLDER_ROUTE.exec(path);
  if (method === 'POST' && disableFolder)
    return { op: 'disable-folder', folder: disableFolder[1]! };
  const state = STATE_ROUTE.exec(path);
  if (method === 'GET' && state) return { op: 'state', keyId: state[1]! };
  return undefined;
}

interface MintBody {
  readonly folder: string;
  readonly bucket: string;
  /** Absent for a state credential. */
  readonly uploadCeilingMib?: number;
}

/**
 * Reads a mint request. The ceiling is mandatory: a request without one is
 * refused, because the upload path holds no default and would refuse every
 * upload from the credential. A present one must be a number the body stage
 * would accept (the body stage's own rule decides) and no more than
 * {@link MAX_UPLOAD_CEILING_MIB}.
 */
function parseMintBody(rawBody: Buffer): MintBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { folder, bucket, uploadCeilingMib } = parsed as Record<string, unknown>;
  if (typeof folder !== 'string' || !FOLDER_PATTERN.test(folder)) return undefined;
  if (typeof bucket !== 'string' || !BUCKET_PATTERN.test(bucket)) return undefined;
  if (typeof uploadCeilingMib !== 'number') return undefined;
  if (uploadCeilingMib > MAX_UPLOAD_CEILING_MIB) return undefined;
  // Only the ceiling is read from this record; the others satisfy its type.
  const candidate: CredentialRecord = {
    folder,
    bucket,
    state: 'active',
    createdAt: '',
    uploadCeilingMib,
  };
  if (!resolveBodyCeiling(candidate).ok) return undefined;
  return { folder, bucket, uploadCeilingMib };
}

/**
 * Reads a state mint request: the tenant's opaque prefix and nothing else. The
 * bucket is the state shard's, fixed by the instance, so a request that names
 * another bucket (or any field this reads not) is refused rather than
 * ignored. There is no upload ceiling: the state process holds one body cap
 * for every state credential, so no per-tenant value is guessed here.
 */
function parseStateMintBody(rawBody: Buffer, stateBucket: string): MintBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  for (const name of Object.keys(fields))
    if (name !== 'folder' && name !== 'bucket') return undefined;
  const { folder, bucket } = fields;
  if (typeof folder !== 'string' || !FOLDER_PATTERN.test(folder)) return undefined;
  if (bucket !== undefined && bucket !== stateBucket) return undefined;
  return { folder, bucket: stateBucket };
}

/**
 * The admin interface: mint, disable and report state. Authentication runs
 * before routing, so an unauthenticated caller learns nothing about which
 * paths exist. A secret appears in exactly one answer, the mint that created
 * its key id; no route reads one back, and a key id is never minted twice.
 */
export function createAdminInterface(deps: AdminDeps) {
  const mintKeyId = deps.newKeyId ?? newKeyId;
  const profile: CredentialProfile = deps.profile ?? 'media';
  const stateBucket = deps.stateBucket;
  if (profile === 'state') {
    if (stateBucket === undefined || !BUCKET_PATTERN.test(stateBucket)) {
      throw new RangeError('a state admin interface needs the state shard bucket');
    }
  } else if (stateBucket !== undefined) {
    throw new RangeError('only a state admin interface names a state shard bucket');
  }

  // The change has already committed when this runs, so a failing logger must
  // not turn the answer into a 503; the loss is reported on stderr instead.
  function logOperation(entry: AdminLogEntry): void {
    try {
      deps.logger.admin(entry);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'NonError';
      try {
        process.stderr.write(
          `admin audit log entry lost: operation=${entry.operation} error=${name}\n`
        );
      } catch {
        // stderr is the last place to report to; nothing is left to try.
      }
    }
  }

  function mint(caller: AdminCaller, rawBody: Buffer): AdminResponse {
    const body =
      profile === 'state' && stateBucket !== undefined
        ? parseStateMintBody(rawBody, stateBucket)
        : parseMintBody(rawBody);
    if (body === undefined) {
      return respond(400, {
        error:
          profile === 'state'
            ? 'body must name a valid state prefix as its folder'
            : 'body must name a valid folder, bucket and upload ceiling',
      });
    }
    const at = new Date(deps.auth.nowMs()).toISOString();
    const inserted = deps.store.insert({
      keyId: mintKeyId(),
      folder: body.folder,
      bucket: body.bucket,
      profile,
      createdAt: at,
      ...(body.uploadCeilingMib === undefined ? {} : { uploadCeilingMib: body.uploadCeilingMib }),
    });
    if (!inserted.ok) {
      return inserted.reason === 'key-id-taken'
        ? respond(409, { error: 'key id already issued; mint again' })
        : respond(409, { error: 'folder has an active credential; disable it by folder first' });
    }
    const credential = inserted.credential;
    const response = respond(201, {
      ...describe(credential),
      secret: deriveTenantSecret(deps.master, credential.keyId, profile),
    });
    logOperation({
      event: 'admin-operation',
      caller,
      operation: 'mint',
      at,
      keyId: credential.keyId,
      folder: credential.folder,
    });
    return response;
  }

  function disable(caller: AdminCaller, keyId: string): AdminResponse {
    const at = new Date(deps.auth.nowMs()).toISOString();
    const result = deps.store.disable(keyId, at);
    if (result === 'unknown') return respond(404, { error: 'no such credential' });
    const credential = deps.store.get(keyId)!;
    const response = respond(200, describe(credential));
    logOperation({
      event: 'admin-operation',
      caller,
      operation: 'disable',
      at,
      keyId,
      folder: credential.folder,
      changed: result === 'disabled' ? 1 : 0,
    });
    return response;
  }

  // Answers with every credential the folder has ever had, so the erasure
  // job sees each key id it must account for. Never with a secret.
  function disableFolder(caller: AdminCaller, folder: string): AdminResponse {
    const at = new Date(deps.auth.nowMs()).toISOString();
    const disabled = deps.store.disableFolder(folder, at);
    const all = deps.store.listByFolder(folder);
    if (all.length === 0) return respond(404, { error: 'no credential for this folder' });
    const response = respond(200, { folder, disabled, credentials: all.map(describe) });
    logOperation({
      event: 'admin-operation',
      caller,
      operation: 'disable-folder',
      at,
      folder,
      changed: disabled,
    });
    return response;
  }

  function state(keyId: string): AdminResponse {
    const credential = deps.store.get(keyId);
    if (credential === undefined) return respond(404, { error: 'no such credential' });
    return respond(200, describe(credential));
  }

  return {
    handle(request: AdminRequest): AdminResponse {
      const auth = authenticateAdmin(
        deps.auth,
        request.method,
        request.path,
        request.headers,
        request.rawBody
      );
      if (!auth.ok) return respond(401, { error: 'not authorised' });

      const routed = route(request.method, request.path);
      if (routed === undefined) return respond(404, { error: 'no such operation' });
      if (!ADMIN_PERMISSIONS[auth.caller].includes(routed.op)) {
        return respond(403, { error: 'this caller may not do that' });
      }
      try {
        switch (routed.op) {
          case 'mint':
            return mint(auth.caller, request.rawBody);
          case 'disable-folder':
            return disableFolder(auth.caller, routed.folder);
          case 'disable':
            return disable(auth.caller, routed.keyId);
          case 'state':
            return state(routed.keyId);
        }
      } catch {
        return respond(503, { error: 'the credential store failed; try again' });
      }
    },
  };
}
