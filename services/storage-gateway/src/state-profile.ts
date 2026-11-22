/**
 * The state profile's admission core: what a tenant's Pulumi state credential
 * may ask of the gateway, and the check that keeps it inside its own prefix of
 * the tenant-state bucket (ghost-platform-docs page 24, "The state profile").
 *
 * It is the same decision the media path makes, with a different allowlist: a
 * state credential may list, read, write and copy under its own prefix and
 * delete only the lock objects Pulumi releases, and nothing else. Where the
 * media path's folder guard is whole-segment on `<folder>/`, so is this one: a
 * prefix of `abc` never reaches `abcd/`.
 *
 * This module is pure. It owns no listener, no upstream key and no storage; the
 * state process that serves it is a separate change.
 */
import type {
  CredentialRecord,
  CredentialStore,
  GatewayRequest,
  Refusal,
  RefusalCode,
  SignatureVerifier,
} from './contracts.js';
import { credentialProfile } from './contracts.js';
import type { GatewayLogger } from './admit.js';
import { refusal } from './refusal.js';
import {
  BUCKET_NAME,
  ENCODED_SEPARATOR_OR_DOT,
  FORBIDDEN_CHARS,
  MAX_KEY_BYTES,
  MAX_TARGET_LENGTH,
  RAW_TARGET_OK,
  decodeOnce,
  hasOperationChangingHeader,
  isSafeSegment,
  parseQuery,
  type Query,
} from './router.js';

/**
 * The request shapes a state credential may send. Multipart calls, bulk
 * delete, versions, ACLs, policy and every bucket-level call except a prefixed
 * listing are not on it. The set is a prediction until the recording run
 * measures what the pinned Pulumi CLI sends; it is only ever narrowed or
 * widened by that measurement, in this one list.
 */
export const STATE_OPERATIONS = [
  'GetObject',
  'HeadObject',
  'PutObject',
  'ListObjectsV2',
  'CopyObject',
  'DeleteObject',
] as const;

export type StateOperation = (typeof STATE_OPERATIONS)[number];

/** A request with the shape of one state operation, before any tenant check. */
export interface StateRoutedRequest {
  readonly operation: StateOperation;
  readonly bucket: string;
  /** The decoded object key; absent for a listing. */
  readonly key?: string;
  /** The decoded `prefix` of a listing; present only for `ListObjectsV2`. */
  readonly listPrefix?: string;
  /**
   * The validated query of a listing, decoded, in the order sent: what the
   * upstream call is rebuilt from, never the client's own target. It never
   * carries the SDK's `x-id` marker or `fetch-owner`, so no owner of the
   * storage project is ever asked for.
   */
  readonly listQuery?: ReadonlyArray<readonly [string, string]>;
  /** Where a copy reads from, decoded; present only for `CopyObject`. */
  readonly copySource?: { readonly bucket: string; readonly key: string };
}

export type StateRouteResult =
  | { readonly ok: true; readonly route: StateRoutedRequest }
  | { readonly ok: false; readonly refusal: Refusal };

/** The folder under which Pulumi keeps its lock objects, below a tenant's prefix. */
export const STATE_LOCK_FOLDER = '.pulumi/locks/';

const LIST_PARAMS = new Set([
  'list-type',
  'prefix',
  'delimiter',
  'max-keys',
  'continuation-token',
  'start-after',
  'encoding-type',
  'fetch-owner',
  'x-id',
]);
const MAX_KEYS = /^[1-9][0-9]{0,3}$/;
/** The most bytes a listing's `continuation-token` or `start-after` may carry. */
const MAX_RESUME_BYTES = 2048;

const refused = (code: RefusalCode): { ok: false; refusal: Refusal } => ({
  ok: false,
  refusal: refusal(code),
});

/** Splits a decoded object name into segments and checks each; `partialLast` lets a listing prefix end at a folder or in a partial name. */
function safeName(decoded: string, partialLast: boolean): boolean {
  const parts = decoded.split('/');
  const last = parts.length - 1;
  return parts.every((part, i) => {
    // A listing prefix may end in `/` (an empty last segment) or in a partial name.
    if (partialLast && i === last && part === '') return true;
    return isSafeSegment(part);
  });
}

/**
 * Reads `x-amz-copy-source`: `bucket/key` or `/bucket/key`, percent-encoded
 * once. A `?versionId=` suffix is refused: a copy of an old version is not a
 * Pulumi operation, and the version would name an object this check cannot see.
 */
function parseCopySource(value: string): { bucket: string; key: string } | undefined {
  const decoded = decodeOnce(value);
  if (decoded === undefined || decoded.includes('?')) return undefined;
  const path = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  const slash = path.indexOf('/');
  if (slash === -1) return undefined;
  const bucket = path.slice(0, slash);
  const key = path.slice(slash + 1);
  if (!BUCKET_NAME.test(bucket) || !safeName(key, false)) return undefined;
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return undefined;
  return { bucket, key };
}

function routeListing(bucket: string, query: Query): StateRouteResult {
  for (const name of query.keys())
    if (!LIST_PARAMS.has(name)) return refused('operation-not-allowed');
  const marker = query.get('x-id');
  if (query.get('list-type') !== '2' || (marker !== undefined && marker !== 'ListObjectsV2')) {
    return refused('operation-not-allowed');
  }
  const prefix = query.get('prefix');
  // A listing with no prefix, or an empty one, would name the whole bucket.
  if (prefix === undefined || prefix === '') return refused('key-outside-folder');
  if (!safeName(prefix, true)) return refused('target-malformed');
  if (new TextEncoder().encode(prefix).length > MAX_KEY_BYTES) return refused('target-malformed');
  const delimiter = query.get('delimiter');
  if (delimiter !== undefined && delimiter !== '/') return refused('operation-not-allowed');
  const maxKeys = query.get('max-keys');
  if (maxKeys !== undefined && !MAX_KEYS.test(maxKeys)) return refused('target-malformed');
  const encoding = query.get('encoding-type');
  if (encoding !== undefined && encoding !== 'url') return refused('operation-not-allowed');
  // A resume point is opaque to the gateway: bounded, and nothing more is read into it.
  for (const name of ['continuation-token', 'start-after']) {
    const value = query.get(name);
    if (value !== undefined && new TextEncoder().encode(value).length > MAX_RESUME_BYTES) {
      return refused('target-malformed');
    }
  }
  const listQuery = [...query.entries()].filter(
    ([name]) => name !== 'x-id' && name !== 'fetch-owner'
  );
  return { ok: true, route: { operation: 'ListObjectsV2', bucket, listPrefix: prefix, listQuery } };
}

/**
 * Decides whether a request is one of the state shapes and that its target is
 * structurally safe. Path-style addressing only: `/<bucket>/<key>`, or
 * `/<bucket>?list-type=2&prefix=...` for a listing. It knows nothing about
 * tenants: {@link guardStateTenant} checks bucket and prefix.
 */
export function routeStateRequest(request: GatewayRequest): StateRouteResult {
  const target = request.rawTarget;
  if (target.length > MAX_TARGET_LENGTH || !RAW_TARGET_OK.test(target) || !target.startsWith('/')) {
    return refused('target-malformed');
  }
  const queryStart = target.indexOf('?');
  const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
  const rawQuery = queryStart === -1 ? '' : target.slice(queryStart + 1);

  const segments = rawPath.slice(1).split('/');
  const bucket = segments[0] ?? '';
  const keySegments = segments.slice(1);
  if (ENCODED_SEPARATOR_OR_DOT.test(rawPath) || !BUCKET_NAME.test(bucket)) {
    return refused('target-malformed');
  }
  const query = parseQuery(rawQuery);
  if (query === undefined) return refused('target-malformed');

  // A bucket-level request: only a prefixed listing is allowed.
  if (keySegments.length === 0 || (keySegments.length === 1 && keySegments[0] === '')) {
    if (request.method !== 'GET' || hasOperationChangingHeader(request)) {
      return refused('operation-not-allowed');
    }
    return routeListing(bucket, query);
  }

  const decodedSegments: string[] = [];
  for (const segment of keySegments) {
    const decoded = decodeOnce(segment);
    if (decoded === undefined || !isSafeSegment(decoded)) return refused('target-malformed');
    decodedSegments.push(decoded);
  }
  const key = decodedSegments.join('/');
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return refused('target-malformed');

  // Only the SDK's own operation marker may ride on an object request.
  for (const name of query.keys()) if (name !== 'x-id') return refused('operation-not-allowed');
  const marker = query.get('x-id');
  const named = (
    operation: StateOperation,
    extra: Partial<StateRoutedRequest> = {}
  ): StateRouteResult =>
    marker === undefined || marker === operation
      ? { ok: true, route: { operation, bucket, key, ...extra } }
      : refused('operation-not-allowed');

  const copy = request.headers['x-amz-copy-source'];
  if (hasOperationChangingHeader(request, ['x-amz-copy-source'])) {
    return refused('operation-not-allowed');
  }
  switch (request.method) {
    case 'GET':
      return copy === undefined ? named('GetObject') : refused('operation-not-allowed');
    case 'HEAD':
      return copy === undefined ? named('HeadObject') : refused('operation-not-allowed');
    case 'DELETE':
      return copy === undefined ? named('DeleteObject') : refused('operation-not-allowed');
    case 'PUT': {
      if (copy === undefined) return named('PutObject');
      // A repeated copy-source header is refused: the upstream would read one
      // and this check another.
      if (typeof copy !== 'string') return refused('operation-not-allowed');
      const copySource = parseCopySource(copy);
      if (copySource === undefined) return refused('target-malformed');
      return named('CopyObject', { copySource });
    }
    default:
      return refused('operation-not-allowed');
  }
}

/** True when `key` is `prefix` followed by at least one more character. */
const strictlyUnder = (key: string, prefix: string): boolean =>
  key.length > prefix.length && key.startsWith(prefix);

/**
 * The state guard. For a `state` credential whose folder is `P`, the request
 * must name the credential's bucket and stay inside `P/`:
 *
 * - an object request names a key under `P/`;
 * - a listing names a `prefix` of `P/` or longer, never the bucket root;
 * - a copy names `P/` for both its destination and its source;
 * - a delete names a lock object under `P/.pulumi/locks/` and nothing else.
 *
 * Every comparison is against `P/` with the trailing slash, so a tenant whose
 * prefix is `abc` cannot reach `abcd/`.
 */
export function guardStateTenant(
  route: StateRoutedRequest,
  credential: CredentialRecord
): Refusal | undefined {
  if (
    credentialProfile(credential) !== 'state' ||
    !isSafeSegment(credential.folder) ||
    FORBIDDEN_CHARS.test(credential.folder) ||
    credential.folder.includes('?') ||
    !BUCKET_NAME.test(credential.bucket)
  ) {
    return refusal('credential-invalid');
  }
  if (route.bucket !== credential.bucket) return refusal('bucket-not-allowed');
  const prefix = `${credential.folder}/`;

  switch (route.operation) {
    case 'ListObjectsV2':
      return route.listPrefix !== undefined && route.listPrefix.startsWith(prefix)
        ? undefined
        : refusal('key-outside-folder');
    case 'CopyObject': {
      const source = route.copySource;
      if (source === undefined || route.key === undefined) return refusal('operation-not-allowed');
      if (source.bucket !== credential.bucket) return refusal('bucket-not-allowed');
      return strictlyUnder(route.key, prefix) && strictlyUnder(source.key, prefix)
        ? undefined
        : refusal('key-outside-folder');
    }
    case 'DeleteObject':
      return route.key !== undefined && strictlyUnder(route.key, `${prefix}${STATE_LOCK_FOLDER}`)
        ? undefined
        : refusal('key-outside-folder');
    default:
      return route.key !== undefined && strictlyUnder(route.key, prefix)
        ? undefined
        : refusal('key-outside-folder');
  }
}

export interface AdmitStateDependencies {
  readonly verifier: SignatureVerifier;
  readonly credentials: CredentialStore;
  readonly logger: GatewayLogger;
}

export type AdmitStateResult =
  | {
      readonly ok: true;
      readonly route: StateRoutedRequest;
      readonly tenant: { readonly keyId: string; readonly folder: string; readonly bucket: string };
    }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * Decides whether a request may be forwarded to the state shard, failing
 * closed. The order is the media path's: who signed it, whether that
 * credential is active, whether it is a `state` credential, whether the
 * request is a state shape, and whether it stays inside the tenant's prefix.
 * Every refusal is logged with the tenant when one is known; a verifier or
 * store that throws is a refusal, never a pass.
 */
export async function admitState(
  request: GatewayRequest,
  deps: AdmitStateDependencies
): Promise<AdmitStateResult> {
  const refuse = (
    code: RefusalCode,
    context: { keyId?: string; folder?: string; operation?: string } = {}
  ): AdmitStateResult => {
    const r = refusal(code);
    deps.logger.refusal({
      event: 'request-refused',
      code,
      status: r.status,
      method: request.method,
      ...(context.keyId === undefined ? {} : { keyId: context.keyId }),
      ...(context.folder === undefined ? {} : { folder: context.folder }),
      ...(context.operation === undefined ? {} : { operation: context.operation }),
    });
    return { ok: false, refusal: r };
  };

  let keyId: string;
  try {
    const verified = await deps.verifier.verify(request);
    if (verified.ok !== true) return refuse(verified.refusal.code);
    if (typeof verified.keyId !== 'string' || verified.keyId === '')
      return refuse('internal-error');
    keyId = verified.keyId;
  } catch {
    return refuse('internal-error');
  }

  let credential;
  try {
    credential = await deps.credentials.lookup(keyId);
  } catch {
    return refuse('internal-error', { keyId });
  }
  // An unknown key id answers exactly as a bad signature does.
  if (credential === undefined) return refuse('signature-refused', { keyId });
  const folder = credential.folder;
  if (credential.state !== 'active') return refuse('credential-not-active', { keyId, folder });
  // A media credential presented here is refused before its request is read.
  if (credentialProfile(credential) !== 'state') {
    return refuse('profile-not-allowed', { keyId, folder });
  }

  const routed = routeStateRequest(request);
  if (!routed.ok) return refuse(routed.refusal.code, { keyId, folder });

  const denied = guardStateTenant(routed.route, credential);
  if (denied !== undefined) {
    return refuse(denied.code, { keyId, folder, operation: routed.route.operation });
  }
  return { ok: true, route: routed.route, tenant: { keyId, folder, bucket: credential.bucket } };
}
