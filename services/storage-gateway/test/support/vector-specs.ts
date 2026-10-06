import { sdkEscape, sha256Hex, type SignSpec } from './reference-signer.js';

/** One reference vector's inputs: what to sign, and optionally an equivalent wire query. */
export interface VectorSpec {
  readonly name: string;
  readonly spec: SignSpec;
  readonly rawQuery?: string;
}

export const VECTOR_IDENTITY = {
  keyId: 'GWTENANTKEY0001',
  secret: 'TEST_ONLY_SECRET/with+base64=chars',
  region: 'nbg1',
  signingDate: '2026-10-06T09:30:15Z',
} as const;

const HOST = 'storage-gateway.internal:8443';
const BUCKET = '/media-shard-a';
const FOLDER = 'q7f3k2m9x1';
const UPLOAD_ID = 'Zm9v+YmFy/YmF6=2~upload.ID_x';

/** Headers the S3 client adds to every request: the unsigned user agent and its retry bookkeeping. */
function sdkHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: HOST,
    'user-agent': 'aws-sdk-js/3.0.0 ua/2.1 os/linux lang/js md/nodejs#26.5.0 api/s3#3.0.0',
    'amz-sdk-invocation-id': '6f1c2b8e-0d4a-4c1e-9a77-2f3b5d6e7f80',
    'amz-sdk-request': 'attempt=1; max=3',
    ...extra,
  };
}

function objectPath(name: string): string {
  return `${BUCKET}/${FOLDER}/${name.split('/').map(sdkEscape).join('/')}`;
}

function upload(body: string, extra: Record<string, string> = {}): Record<string, string> {
  return sdkHeaders({
    'content-length': String(Buffer.byteLength(body)),
    'x-amz-checksum-crc32': 'NSRBwg==',
    'x-amz-sdk-checksum-algorithm': 'CRC32',
    ...extra,
  });
}

const IMAGE = 'PNG_PLACEHOLDER_BYTES';
const COMPLETE_XML =
  '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><ETag>"etag-1"</ETag><PartNumber>1</PartNumber></Part></CompleteMultipartUpload>';

/** The eight request shapes Ghost 6.55 sends, as the S3 client puts them on the wire. */
const GHOST_SHAPES: VectorSpec[] = [
  {
    name: 'ghost PutObject',
    spec: {
      method: 'PUT',
      path: objectPath('2026/10/photo.png'),
      query: { 'x-id': 'PutObject' },
      headers: upload(IMAGE, { 'content-type': 'image/png', 'cache-control': 'max-age=31536000' }),
      body: IMAGE,
      payloadHash: sha256Hex(IMAGE),
    },
  },
  {
    name: 'ghost CreateMultipartUpload',
    spec: {
      method: 'POST',
      path: objectPath('2026/10/video.mp4'),
      query: { uploads: '', 'x-id': 'CreateMultipartUpload' },
      headers: sdkHeaders({ 'content-type': 'video/mp4', 'content-length': '0' }),
    },
  },
  {
    name: 'ghost CreateMultipartUpload, bare uploads flag on the wire',
    spec: {
      method: 'POST',
      path: objectPath('2026/10/video.mp4'),
      query: { uploads: '', 'x-id': 'CreateMultipartUpload' },
      headers: sdkHeaders({ 'content-type': 'video/mp4', 'content-length': '0' }),
    },
    rawQuery: 'uploads&x-id=CreateMultipartUpload',
  },
  {
    name: 'ghost UploadPart',
    spec: {
      method: 'PUT',
      path: objectPath('2026/10/video.mp4'),
      query: { partNumber: '1', uploadId: UPLOAD_ID, 'x-id': 'UploadPart' },
      headers: upload('PART_ONE_BYTES'),
      body: 'PART_ONE_BYTES',
      payloadHash: sha256Hex('PART_ONE_BYTES'),
    },
  },
  {
    name: 'ghost CompleteMultipartUpload',
    spec: {
      method: 'POST',
      path: objectPath('2026/10/video.mp4'),
      query: { uploadId: UPLOAD_ID, 'x-id': 'CompleteMultipartUpload' },
      headers: sdkHeaders({
        'content-type': 'application/xml',
        'content-length': String(Buffer.byteLength(COMPLETE_XML)),
      }),
      body: COMPLETE_XML,
      payloadHash: sha256Hex(COMPLETE_XML),
    },
  },
  {
    name: 'ghost AbortMultipartUpload',
    spec: {
      method: 'DELETE',
      path: objectPath('2026/10/video.mp4'),
      query: { uploadId: UPLOAD_ID, 'x-id': 'AbortMultipartUpload' },
      headers: sdkHeaders(),
    },
  },
  {
    name: 'ghost HeadObject',
    spec: {
      method: 'HEAD',
      path: objectPath('2026/10/photo.png'),
      query: { 'x-id': 'HeadObject' },
      headers: sdkHeaders(),
    },
  },
  {
    name: 'ghost GetObject',
    spec: {
      method: 'GET',
      path: objectPath('2026/10/photo.png'),
      query: { 'x-id': 'GetObject' },
      headers: sdkHeaders(),
    },
  },
  {
    name: 'ghost DeleteObject',
    spec: {
      method: 'DELETE',
      path: objectPath('2026/10/photo_o.png'),
      query: { 'x-id': 'DeleteObject' },
      headers: sdkHeaders(),
    },
  },
];

const AWKWARD_NAMES = [
  'a b/c d.png',
  'plus+sign.png',
  'per%cent.png',
  "sub-delims!$&'()*+,;=.png",
  'question?mark#hash.png',
  'tilde~dash-under_dot.png',
  'café/日本語/\u{1f600}.png',
  'colon:at@bracket[x].png',
  'back\\slash"quote<lt>gt`tick.png',
  'deep/'.repeat(20) + 'file.png',
  'x'.repeat(900) + '.png',
];

const AWKWARD_OBJECTS: VectorSpec[] = AWKWARD_NAMES.map((n, i) => ({
  name: `awkward object name ${i + 1}`,
  spec: {
    method: 'GET',
    path: objectPath(n),
    query: { 'x-id': 'GetObject' },
    headers: sdkHeaders(),
  },
}));

const AWKWARD_HEADERS: VectorSpec[] = [
  {
    name: 'header values needing trim and whitespace collapse',
    spec: {
      method: 'PUT',
      path: objectPath('h.png'),
      query: { 'x-id': 'PutObject' },
      headers: upload(IMAGE, {
        'content-type': '  image/png  ',
        'x-amz-meta-note': 'two  spaces\tand a tab   end ',
        'content-disposition': 'attachment;  filename="a  b.png"',
      }),
      body: IMAGE,
      payloadHash: sha256Hex(IMAGE),
    },
  },
  {
    name: 'header values with commas and equals signs',
    spec: {
      method: 'PUT',
      path: objectPath('h2.png'),
      query: { 'x-id': 'PutObject' },
      headers: upload(IMAGE, {
        'content-type': 'image/png',
        'x-amz-meta-list': 'a,b, c ,d',
        'x-amz-meta-kv': 'k=v; q="x=y"',
      }),
      body: IMAGE,
      payloadHash: sha256Hex(IMAGE),
    },
  },
  {
    name: 'payload hash computed by the reference signer',
    spec: {
      method: 'PUT',
      path: objectPath('signer-hashed.bin'),
      query: { 'x-id': 'PutObject' },
      headers: upload('BODY_HASHED_BY_SIGNER'),
      body: 'BODY_HASHED_BY_SIGNER',
    },
  },
  {
    name: 'empty body with an explicit empty-payload hash',
    spec: {
      method: 'PUT',
      path: objectPath('empty.txt'),
      query: { 'x-id': 'PutObject' },
      headers: upload('', { 'content-type': 'text/plain' }),
      body: '',
      payloadHash: sha256Hex(''),
    },
  },
];

const AWKWARD_QUERIES: VectorSpec[] = [
  {
    name: 'query sent out of order and with lower-case hex',
    spec: {
      method: 'PUT',
      path: objectPath('q.png'),
      query: { uploadId: UPLOAD_ID, partNumber: '10000', 'x-id': 'UploadPart' },
      headers: upload('P'),
      body: 'P',
      payloadHash: sha256Hex('P'),
    },
    rawQuery: `x-id=UploadPart&uploadId=${sdkEscape(UPLOAD_ID).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase())}&partNumber=10000`,
  },
  {
    name: 'query with unreserved characters needlessly percent-encoded',
    spec: {
      method: 'GET',
      path: objectPath('q2.png'),
      query: { 'x-id': 'GetObject' },
      headers: sdkHeaders(),
    },
    rawQuery: '%78%2Did=%47etObject',
  },
  {
    name: 'query values needing encoding: space, slash, unicode',
    spec: {
      method: 'GET',
      path: objectPath('q3.png'),
      query: { 'x-id': 'GetObject', 'response-content-disposition': 'inline; filename="é /x.png"' },
      headers: sdkHeaders(),
    },
  },
  {
    name: 'repeated query name, values sorted by the signer',
    spec: {
      method: 'GET',
      path: objectPath('q4.png'),
      query: { 'x-id': 'GetObject', tag: ['zeta', 'alpha', 'Mid'] },
      headers: sdkHeaders(),
    },
  },
];

export const VECTOR_SPECS: readonly VectorSpec[] = [
  ...GHOST_SHAPES,
  ...AWKWARD_OBJECTS,
  ...AWKWARD_HEADERS,
  ...AWKWARD_QUERIES,
];
