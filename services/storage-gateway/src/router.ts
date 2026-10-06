import type { AllowedOperation, CredentialRecord, GatewayRequest, Refusal } from './contracts.js';
import { refusal } from './refusal.js';

/** A request that has the shape of one of the seven allowed operations. */
export interface RoutedRequest {
  readonly operation: AllowedOperation;
  readonly bucket: string;
  /** The decoded object key, structurally safe but not yet checked against a tenant folder. */
  readonly key: string;
  readonly uploadId?: string;
  readonly partNumber?: number;
}

export type RouteResult =
  | { readonly ok: true; readonly route: RoutedRequest }
  | { readonly ok: false; readonly refusal: Refusal };

const MAX_TARGET_LENGTH = 4096;
const MAX_KEY_BYTES = 1024;
const MAX_PART_NUMBER = 10000;

/** Bytes a raw target may carry: printable ASCII without space, backslash or `#`. */
const RAW_TARGET_OK = /^[\x21\x22\x24-\x5b\x5d-\x7e]+$/;
/** Percent-encodings of `/`, `\` and `.`, refused outright rather than decoded. */
const ENCODED_SEPARATOR_OR_DOT = /%(?:2f|5c|2e)/i;
const BUCKET_NAME = /^(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PART_NUMBER = /^[1-9][0-9]{0,4}$/;
/** Control, format and non-space separator characters: never in an object name. */
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Zs}]/u;

const refused = (code: Parameters<typeof refusal>[0]): { ok: false; refusal: Refusal } => ({
  ok: false,
  refusal: refusal(code),
});

/** Decodes percent-encoding once; `undefined` for a malformed or overlong sequence. */
function decodeOnce(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** True when the text, read as one path segment, could act as a separator, dot-segment or escape. */
function isDangerousSegment(text: string): boolean {
  return (
    text === '' ||
    text === '.' ||
    text === '..' ||
    text.includes('/') ||
    text.includes('\\') ||
    text.includes('%')
  );
}

/**
 * Validates one decoded path segment. The segment is checked as decoded and
 * again after NFKC folding, because a fullwidth or dot-leader character folds
 * to `/`, `.` or `%` under normalisation, and any layer downstream that
 * normalises must not be handed a way out. A segment that is not already NFC
 * is refused too, so one object never has two spellings.
 */
function isSafeSegment(decoded: string): boolean {
  // A plain space is the one separator allowed in an object name.
  if (FORBIDDEN_CHARS.test(decoded.replaceAll(' ', ''))) return false;
  if (isDangerousSegment(decoded)) return false;
  if (decoded.normalize('NFC') !== decoded) return false;
  return !isDangerousSegment(decoded.normalize('NFKC'));
}

type Query = ReadonlyMap<string, string>;

/** Parses the query string strictly; `undefined` when it is malformed or repeats a name. */
function parseQuery(raw: string): Query | undefined {
  const params = new Map<string, string>();
  if (raw === '') return params;
  for (const pair of raw.split('&')) {
    const eq = pair.indexOf('=');
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    // The SDK never encodes a parameter name, and a decoded name would let
    // `upload%49d` choose the operation while an upstream that does not decode
    // names sees something else.
    if (rawName.includes('%')) return undefined;
    const name = decodeOnce(rawName);
    const value = decodeOnce(eq === -1 ? '' : pair.slice(eq + 1));
    if (name === undefined || value === undefined || name === '') return undefined;
    if (FORBIDDEN_CHARS.test(name) || FORBIDDEN_CHARS.test(value)) return undefined;
    if (params.has(name)) return undefined;
    params.set(name, value);
  }
  return params;
}

/**
 * Headers that change what an allowed request does: copy, ACLs and grants,
 * tagging, metadata directives, any server-side encryption, website redirect,
 * object lock and storage class. Ghost sends none of them, so a request that
 * carries one is not Ghost and is refused rather than stripped: stripping
 * would alter signed headers and hide the caller.
 */
const OPERATION_CHANGING_HEADERS = [
  'x-amz-copy-source',
  'x-amz-acl',
  'x-amz-grant-',
  'x-amz-tagging',
  'x-amz-metadata-directive',
  'x-amz-server-side-encryption',
  'x-amz-website-redirect-location',
  'x-amz-object-lock-',
  'x-amz-bypass-governance-retention',
  'x-amz-storage-class',
];

function hasOperationChangingHeader(request: GatewayRequest): boolean {
  return Object.keys(request.headers).some((name) => {
    const lower = name.toLowerCase();
    return OPERATION_CHANGING_HEADERS.some((prefix) => lower.startsWith(prefix));
  });
}

/** Names of the query parameters the seven shapes may carry. */
const KNOWN_PARAMS = new Set(['x-id', 'uploads', 'uploadId', 'partNumber']);

/**
 * Names the operation from method and query alone. `undefined` means the
 * request is not one of the seven shapes. The SDK's `x-id` marker is accepted
 * only when it names the operation the rest of the request already means.
 */
function classify(method: string, query: Query): AllowedOperation | undefined {
  for (const name of query.keys()) if (!KNOWN_PARAMS.has(name)) return undefined;
  const marker = query.get('x-id');
  const only = (...names: string[]): boolean =>
    [...query.keys()].every((n) => n === 'x-id' || names.includes(n)) &&
    names.every((n) => query.has(n));
  const named = (operation: AllowedOperation): AllowedOperation | undefined =>
    marker === undefined || marker === operation ? operation : undefined;

  switch (method) {
    case 'PUT':
      if (only()) return named('PutObject');
      if (only('partNumber', 'uploadId')) return named('UploadPart');
      return undefined;
    case 'POST':
      if (only('uploads') && query.get('uploads') === '') return named('CreateMultipartUpload');
      if (only('uploadId')) return named('CompleteMultipartUpload');
      return undefined;
    case 'DELETE':
      return only('uploadId') ? named('AbortMultipartUpload') : undefined;
    case 'GET':
      return only() ? named('GetObject') : undefined;
    case 'HEAD':
      return only() ? named('HeadObject') : undefined;
    default:
      return undefined;
  }
}

/**
 * Decides whether a request is one of the seven shapes Ghost 6.55 sends, and
 * that its target is structurally safe. Path-style addressing only:
 * `/<bucket>/<key>`. It knows nothing about tenants: {@link guardTenant}
 * checks the bucket and folder.
 */
export function routeRequest(request: GatewayRequest): RouteResult {
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

  // A bucket-level request: list, create, bucket policy and the rest.
  if (keySegments.length === 0 || (keySegments.length === 1 && keySegments[0] === '')) {
    return refused('operation-not-allowed');
  }

  if (ENCODED_SEPARATOR_OR_DOT.test(rawPath) || !BUCKET_NAME.test(bucket)) {
    return refused('target-malformed');
  }

  const decodedSegments: string[] = [];
  for (const segment of keySegments) {
    const decoded = decodeOnce(segment);
    if (decoded === undefined || !isSafeSegment(decoded)) return refused('target-malformed');
    decodedSegments.push(decoded);
  }
  const key = decodedSegments.join('/');
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return refused('target-malformed');

  const query = parseQuery(rawQuery);
  if (query === undefined) return refused('target-malformed');

  const operation = classify(request.method, query);
  if (operation === undefined || hasOperationChangingHeader(request))
    return refused('operation-not-allowed');

  const uploadId = query.get('uploadId');
  const partText = query.get('partNumber');
  if (uploadId === '') return refused('target-malformed');
  let partNumber: number | undefined;
  if (partText !== undefined) {
    if (!PART_NUMBER.test(partText) || Number(partText) > MAX_PART_NUMBER) {
      return refused('target-malformed');
    }
    partNumber = Number(partText);
  }

  return {
    ok: true,
    route: {
      operation,
      bucket,
      key,
      ...(uploadId === undefined ? {} : { uploadId }),
      ...(partNumber === undefined ? {} : { partNumber }),
    },
  };
}

/**
 * The folder guard. The request must name the tenant's assigned bucket and an
 * object key of the form `<folder>/<name...>`, with at least one name segment
 * after the folder. Exact, case-sensitive comparison on whole segments: a key
 * that merely starts with the folder's characters does not pass.
 */
export function guardTenant(
  route: RoutedRequest,
  credential: CredentialRecord
): Refusal | undefined {
  if (!isValidFolder(credential.folder) || !BUCKET_NAME.test(credential.bucket)) {
    return refusal('credential-invalid');
  }
  if (route.bucket !== credential.bucket) return refusal('bucket-not-allowed');
  const separator = route.key.indexOf('/');
  if (separator === -1 || separator === route.key.length - 1) return refusal('key-outside-folder');
  if (route.key.slice(0, separator) !== credential.folder) return refusal('key-outside-folder');
  return undefined;
}

function isValidFolder(folder: string): boolean {
  return isSafeSegment(folder) && !folder.includes('?');
}
