import { randomBytes } from 'node:crypto';
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

export interface AdminDeps {
  readonly auth: AdminAuthDeps;
  readonly store: Pick<
    SqliteCredentialStore,
    'insert' | 'disable' | 'get' | 'disableFolder' | 'listByFolder'
  >;
  readonly master: MasterSecret;
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
    state: credential.state,
    createdAt: credential.createdAt,
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

function parseMintBody(rawBody: Buffer): { folder: string; bucket: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { folder, bucket } = parsed as Record<string, unknown>;
  if (typeof folder !== 'string' || !FOLDER_PATTERN.test(folder)) return undefined;
  if (typeof bucket !== 'string' || !BUCKET_PATTERN.test(bucket)) return undefined;
  return { folder, bucket };
}

/**
 * The admin interface: mint, disable and report state. Authentication runs
 * before routing, so an unauthenticated caller learns nothing about which
 * paths exist. A secret appears in exactly one answer, the mint that created
 * its key id; no route reads one back, and a key id is never minted twice.
 */
export function createAdminInterface(deps: AdminDeps) {
  const mintKeyId = deps.newKeyId ?? newKeyId;

  function mint(rawBody: Buffer): AdminResponse {
    const body = parseMintBody(rawBody);
    if (body === undefined)
      return respond(400, { error: 'body must name a valid folder and bucket' });
    const inserted = deps.store.insert({
      keyId: mintKeyId(),
      folder: body.folder,
      bucket: body.bucket,
      createdAt: new Date(deps.auth.nowMs()).toISOString(),
    });
    if (!inserted.ok) {
      return inserted.reason === 'key-id-taken'
        ? respond(409, { error: 'key id already issued; mint again' })
        : respond(409, { error: 'folder has an active credential; disable it by folder first' });
    }
    const credential = inserted.credential;
    return respond(201, {
      ...describe(credential),
      secret: deriveTenantSecret(deps.master, credential.keyId),
    });
  }

  function disable(keyId: string): AdminResponse {
    const result = deps.store.disable(keyId);
    if (result === 'unknown') return respond(404, { error: 'no such credential' });
    return respond(200, describe(deps.store.get(keyId)!));
  }

  // Answers with every credential the folder has ever had, so the erasure
  // job sees each key id it must account for. Never with a secret.
  function disableFolder(folder: string): AdminResponse {
    const disabled = deps.store.disableFolder(folder);
    const all = deps.store.listByFolder(folder);
    if (all.length === 0) return respond(404, { error: 'no credential for this folder' });
    return respond(200, { folder, disabled, credentials: all.map(describe) });
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
            return mint(request.rawBody);
          case 'disable-folder':
            return disableFolder(routed.folder);
          case 'disable':
            return disable(routed.keyId);
          case 'state':
            return state(routed.keyId);
        }
      } catch {
        return respond(503, { error: 'the credential store failed; try again' });
      }
    },
  };
}
