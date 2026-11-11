import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { admit, type RefusalLogEntry } from '../src/admit.js';
import { SPOOL_THRESHOLD_BYTES, receiveBody, resolveBodyCeiling } from '../src/body.js';
import type {
  CredentialRecord,
  CredentialStore,
  GatewayRequest,
  Refusal,
} from '../src/contracts.js';
import { routeRequest } from '../src/router.js';
import { SigV4Verifier } from '../src/sigv4-verifier.js';
import { createInMemoryUploadBindings } from '../src/uploads.js';
import {
  UpstreamCredentials,
  createUpstream,
  type UpstreamAnswer,
  type UpstreamLogEntry,
  type UpstreamTransport,
} from '../src/upstream.js';
import { referenceSign, type SignSpec } from './support/reference-signer.js';
import {
  IDENTITY,
  KEY_ID,
  REGION,
  SIGNING_DATE,
  makeVerifier,
  withHeaders,
} from './support/verifier-fixtures.js';

/*
 * What this proves, and what it cannot. The tenant's requests go through the
 * gateway's own code (verify, admit, route, body stage, re-sign) and reach a
 * fake transport that records what the gateway sends. Nothing here is a
 * storage service: whatever the fake answers is scripted. The tests say what
 * the gateway puts on the wire, not what Hetzner does with it.
 */

const MIB = 1024 * 1024;
const PART_SIZES: readonly number[] = [5 * MIB, 5 * MIB, 2 * MIB];
const BUCKET = 'media-shard-a';
const FOLDER = 'q7f3k2m9x1';
const OBJECT_PATH = `/${BUCKET}/${FOLDER}/big.bin`;
const HOST = 'storage-gateway.internal:8443';
const REAL_KEY_ID = 'REALHETZNERKEYID01';
const REAL_SECRET = 'REAL_SECRET_MUST_NEVER_APPEAR';
const UPLOAD_ID = 'upload-id-1';
const FIXED_NOW = SIGNING_DATE.getTime();

const RECORD: CredentialRecord = {
  folder: FOLDER,
  bucket: BUCKET,
  state: 'active',
  createdAt: '2026-10-06T00:00:00Z',
  uploadCeilingMib: 16,
};

const credentials: CredentialStore = {
  lookup: async (keyId) => (keyId === KEY_ID ? RECORD : undefined),
};

/** What an SDK adds to every call; the gateway owns or replaces all of it. */
const SDK_HEADERS: Readonly<Record<string, string>> = {
  host: HOST,
  'user-agent': 'TENANT_SDK_AGENT',
  'x-amz-user-agent': 'TENANT_SDK_AGENT',
  'amz-sdk-invocation-id': 'INVOCATION_ID',
  'amz-sdk-request': 'attempt=1',
};

/** The headers every upstream call carries whatever the client signed. */
const GATEWAY_HEADERS: readonly string[] = [
  'authorization',
  'content-length',
  'host',
  'x-amz-content-sha256',
  'x-amz-date',
];

const isChecksumHeader = (name: string): boolean =>
  name.startsWith('x-amz-checksum-') || name === 'x-amz-sdk-checksum-algorithm';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function crc32Base64(data: Buffer): string {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(crc32(data));
  return out.toString('base64');
}

function partBytes(partNumber: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + partNumber * 17 + 7) & 0xff;
  return out;
}

function chunked(data: Buffer, chunkSize = 64 * 1024): Readable {
  const chunks: Buffer[] = [];
  for (let at = 0; at < data.length; at += chunkSize) {
    chunks.push(data.subarray(at, at + chunkSize));
  }
  return Readable.from(chunks);
}

async function drain(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** One request as the fake storage service received it. */
interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodySize: number;
  readonly bodySha256: string;
  /** The body as text when it is small enough to be a control document; empty for a part. */
  readonly bodyText: string;
  /** The spool files on disk at the moment the transport was reached. */
  readonly spoolFiles: readonly string[];
}

interface Reply {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

type Script = (call: Call, earlier: readonly Call[]) => Reply;

const isCreate = (call: Call): boolean =>
  call.method === 'POST' && call.url.searchParams.has('uploads');
const isComplete = (call: Call): boolean => call.method === 'POST' && !isCreate(call);

/** A storage service that accepts everything the way S3 does, and echoes a part checksum it was sent. */
const acceptAll: Script = (call) => {
  if (isCreate(call)) {
    return {
      status: 200,
      body: `<InitiateMultipartUploadResult><UploadId>${UPLOAD_ID}</UploadId></InitiateMultipartUploadResult>`,
    };
  }
  if (isComplete(call)) return { status: 200, body: '<CompleteMultipartUploadResult/>' };
  const crc = call.headers['x-amz-checksum-crc32'];
  return {
    status: 200,
    headers: {
      etag: `"${call.bodySha256.slice(0, 32)}"`,
      ...(crc === undefined ? {} : { 'x-amz-checksum-crc32': crc }),
    },
  };
};

/** The storage service as the gateway's key sees it: only the real key's signature is accepted. */
const realKeyVerifier = new SigV4Verifier({
  region: REGION,
  secrets: { signingSecret: async (id) => (id === REAL_KEY_ID ? REAL_SECRET : undefined) },
  now: () => FIXED_NOW,
});

async function signedByRealKey(call: Call): Promise<boolean> {
  const verdict = await realKeyVerifier.verify({
    method: call.method,
    rawTarget: `${call.url.pathname}${call.url.search}`,
    headers: { ...call.headers },
    bodySha256: call.bodySha256,
  });
  return verdict.ok;
}

type Sent =
  | { readonly ok: true; readonly answer: UpstreamAnswer }
  | { readonly ok: false; readonly refusal: Refusal };

interface Rig {
  readonly calls: Call[];
  readonly refusals: RefusalLogEntry[];
  readonly upstreamLogs: UpstreamLogEntry[];
  readonly uploads: ReturnType<typeof createInMemoryUploadBindings>;
  /** One client request through verify, admit, route, the body stage and the upstream call. */
  send(
    spec: SignSpec,
    payload: Buffer,
    tweak?: (request: GatewayRequest) => GatewayRequest
  ): Promise<Sent>;
}

let spoolDir: string;

beforeEach(async () => {
  spoolDir = await mkdtemp(join(tmpdir(), 'multipart-complete-'));
});

afterEach(async () => {
  await rm(spoolDir, { recursive: true, force: true });
});

function makeRig(script: Script = acceptAll): Rig {
  const calls: Call[] = [];
  const refusals: RefusalLogEntry[] = [];
  const upstreamLogs: UpstreamLogEntry[] = [];
  const uploads = createInMemoryUploadBindings();
  const verifier = makeVerifier();

  const transport: UpstreamTransport = async (req) => {
    const spoolFiles = await readdir(spoolDir);
    const bytes = req.body === undefined ? Buffer.alloc(0) : await drain(req.body);
    const call: Call = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodySize: bytes.length,
      bodySha256: sha256(bytes),
      bodyText: bytes.length <= 64 * 1024 ? bytes.toString('utf8') : '',
      spoolFiles,
    };
    const reply = script(call, calls);
    calls.push(call);
    return {
      status: reply.status,
      headers: reply.headers ?? {},
      body: Readable.from([Buffer.from(reply.body ?? '')]),
    };
  };

  const upstream = createUpstream({
    endpoint: 'https://nbg1.storage.invalid',
    region: REGION,
    credentials: new UpstreamCredentials(REAL_KEY_ID, REAL_SECRET),
    deadlineMs: 5000,
    now: () => FIXED_NOW,
    transport,
    uploads,
    logger: { upstream: (entry) => upstreamLogs.push(entry) },
  });

  const deps = {
    verifier,
    credentials,
    uploads,
    logger: { refusal: (e: RefusalLogEntry) => refusals.push(e) },
  };

  return {
    calls,
    refusals,
    upstreamLogs,
    uploads,
    async send(spec, payload, tweak) {
      const digest = sha256(payload);
      const signed = (await referenceSign({ ...spec, payloadHash: digest }, IDENTITY)).request;
      const base: GatewayRequest = { ...signed, bodySha256: digest };
      const request = tweak === undefined ? base : tweak(base);
      const admitted = await admit(request, deps);
      if (!admitted.ok) return { ok: false, refusal: admitted.refusal };

      const ceiling = resolveBodyCeiling(RECORD);
      if (!ceiling.ok) throw new Error(`no ceiling: ${ceiling.refusal.code}`);
      const received = await receiveBody(chunked(payload), {
        ceilingBytes: ceiling.bytes,
        spoolDir,
        declaredLength: payload.length,
        log: { method: spec.method },
      });
      if (!received.ok) throw new Error(`body refused: ${received.refusal.code}`);
      try {
        const answer = await upstream.forward({
          request,
          route: admitted.route,
          tenant: admitted.tenant,
          body: received.body,
        });
        return { ok: true, answer };
      } finally {
        await received.body.dispose();
      }
    },
  };
}

function answerOf(sent: Sent): UpstreamAnswer {
  if (!sent.ok) throw new Error(`the gateway refused the request: ${sent.refusal.code}`);
  return sent.answer;
}

/** How the client treats checksums, the one thing the three scenarios vary. */
interface Client {
  /** Sign `x-amz-checksum-crc32` (and the SDK's algorithm marker) on each part, and the algorithm on create. */
  readonly signPartCrc32: boolean;
  /** Put a `ChecksumCRC32` element for each part in the complete document. */
  readonly completeNamesCrc32: boolean;
  /** Extra signed headers on every call, to show what the allowlist drops. */
  readonly extraSigned?: Readonly<Record<string, string>>;
}

const NO_CHECKSUMS: Client = { signPartCrc32: false, completeNamesCrc32: false };

interface Upload {
  readonly parts: readonly Buffer[];
  readonly crcs: readonly string[];
  readonly partAnswers: readonly UpstreamAnswer[];
  readonly completeXml: string;
  readonly completeSent: Sent;
}

/** Create, three parts of 5, 5 and 2 MiB, then complete: 12 MiB in all. */
async function uploadTwelveMiB(rig: Rig, client: Client): Promise<Upload> {
  const extra = client.extraSigned ?? {};
  const created = answerOf(
    await rig.send(
      {
        method: 'POST',
        path: OBJECT_PATH,
        query: { uploads: '', 'x-id': 'CreateMultipartUpload' },
        headers: {
          ...SDK_HEADERS,
          ...extra,
          ...(client.signPartCrc32
            ? { 'x-amz-checksum-algorithm': 'CRC32', 'x-amz-checksum-type': 'COMPOSITE' }
            : {}),
        },
      },
      Buffer.alloc(0)
    )
  );
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(String(created.body))?.[1];
  if (uploadId === undefined) throw new Error('the create answer carried no upload id');

  const parts = PART_SIZES.map((size, i) => partBytes(i + 1, size));
  const crcs = parts.map(crc32Base64);
  const partAnswers: UpstreamAnswer[] = [];
  for (const [i, bytes] of parts.entries()) {
    partAnswers.push(
      answerOf(
        await rig.send(
          {
            method: 'PUT',
            path: OBJECT_PATH,
            query: { 'x-id': 'UploadPart', partNumber: String(i + 1), uploadId },
            headers: {
              ...SDK_HEADERS,
              ...extra,
              'content-length': String(bytes.length),
              ...(client.signPartCrc32
                ? {
                    'x-amz-checksum-crc32': crcs[i] as string,
                    'x-amz-sdk-checksum-algorithm': 'CRC32',
                  }
                : {}),
            },
          },
          bytes
        )
      )
    );
  }

  const completeXml =
    '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    partAnswers
      .map(
        (answer, i) =>
          `<Part><PartNumber>${i + 1}</PartNumber><ETag>${answer.headers.etag}</ETag>` +
          (client.completeNamesCrc32 ? `<ChecksumCRC32>${crcs[i]}</ChecksumCRC32>` : '') +
          '</Part>'
      )
      .join('') +
    '</CompleteMultipartUpload>';
  const completeSent = await rig.send(
    {
      method: 'POST',
      path: OBJECT_PATH,
      query: { 'x-id': 'CompleteMultipartUpload', uploadId },
      headers: {
        ...SDK_HEADERS,
        ...extra,
        'content-type': 'application/xml',
        'content-length': String(Buffer.byteLength(completeXml)),
      },
    },
    Buffer.from(completeXml)
  );
  return { parts, crcs, partAnswers, completeXml, completeSent };
}

const wireNames = (call: Call): string[] => Object.keys(call.headers).sort();
const withNames = (...extra: string[]): string[] => [...GATEWAY_HEADERS, ...extra].sort();
const label = (call: Call): string => `${call.method} ${call.url.search}`;

const SEQUENCE = [
  'POST ?uploads=',
  `PUT ?partNumber=1&uploadId=${UPLOAD_ID}`,
  `PUT ?partNumber=2&uploadId=${UPLOAD_ID}`,
  `PUT ?partNumber=3&uploadId=${UPLOAD_ID}`,
  `POST ?uploadId=${UPLOAD_ID}`,
];

describe('multipart complete: a client that signed no checksum header', () => {
  it('reaches the storage service with no checksum header and no checksum element, 12 MiB through the spool', async () => {
    const rig = makeRig();
    const upload = await uploadTwelveMiB(rig, NO_CHECKSUMS);

    expect(rig.refusals).toEqual([]);
    expect(rig.calls.map(label)).toEqual(SEQUENCE);
    expect(answerOf(upload.completeSent).status).toBe(200);

    for (const call of rig.calls) {
      expect(Object.keys(call.headers).filter(isChecksumHeader)).toEqual([]);
      expect(await signedByRealKey(call)).toBe(true);
      expect(String(call.headers.authorization)).toContain(`Credential=${REAL_KEY_ID}/`);
    }
    const [create, ...rest] = rig.calls;
    const complete = rest.pop() as Call;
    expect(wireNames(create as Call)).toEqual(withNames());
    for (const part of rest) expect(wireNames(part)).toEqual(withNames());
    expect(wireNames(complete)).toEqual(withNames('content-type'));

    expect(complete.bodyText).toBe(upload.completeXml);
    expect(complete.bodyText).toContain('<Part>');
    expect(complete.bodyText).not.toMatch(/Checksum/);
  });

  it('hands the 12 MiB to the storage service intact, spooling the parts above the threshold and not the one below it', async () => {
    const rig = makeRig();
    const upload = await uploadTwelveMiB(rig, NO_CHECKSUMS);

    const partCalls = rig.calls.slice(1, 4);
    expect(PART_SIZES.reduce((a, b) => a + b, 0)).toBe(12 * MIB);
    expect(partCalls.map((c) => c.bodySize)).toEqual([...PART_SIZES]);
    expect(partCalls.map((c) => c.bodySha256)).toEqual(upload.parts.map(sha256));
    expect(partCalls.map((c) => c.headers['content-length'])).toEqual(PART_SIZES.map(String));

    expect(PART_SIZES[0]).toBeGreaterThan(SPOOL_THRESHOLD_BYTES);
    expect(PART_SIZES[2]).toBeLessThanOrEqual(SPOOL_THRESHOLD_BYTES);
    expect(partCalls.map((c) => c.spoolFiles.length)).toEqual([1, 1, 0]);
    for (const call of partCalls.slice(0, 2)) {
      expect(call.spoolFiles[0]).toMatch(/^bl-spool-[0-9a-f-]{36}\.part$/);
    }
    expect(await readdir(spoolDir)).toEqual([]);
    expect(
      rig.uploads.isBound(UPLOAD_ID, { keyId: KEY_ID, bucket: BUCKET, key: `${FOLDER}/big.bin` })
    ).toBe(false);
  });

  it('drops the SDK headers the gateway owns, which the client signed', async () => {
    const rig = makeRig();
    await uploadTwelveMiB(rig, NO_CHECKSUMS);
    for (const call of rig.calls) {
      for (const owned of [
        'user-agent',
        'x-amz-user-agent',
        'amz-sdk-invocation-id',
        'amz-sdk-request',
      ]) {
        expect(call.headers[owned]).toBeUndefined();
      }
    }
  });

  it('never forwards a checksum header the signature did not cover: verify refuses it, and a caller that skipped admission still cannot send it', async () => {
    const stray = { 'x-amz-checksum-crc32': 'AAAAAA==', 'x-amz-sdk-checksum-algorithm': 'CRC32' };
    const part = (rig: Rig): Promise<Sent> =>
      rig.send(
        {
          method: 'PUT',
          path: OBJECT_PATH,
          query: { 'x-id': 'UploadPart', partNumber: '1', uploadId: UPLOAD_ID },
          headers: { ...SDK_HEADERS, 'content-length': '4' },
        },
        Buffer.from('PART'),
        (r) => withHeaders(r, stray)
      );

    const refusedRig = makeRig();
    refusedRig.uploads.bind(UPLOAD_ID, { keyId: KEY_ID, bucket: BUCKET, key: `${FOLDER}/big.bin` });
    const refused = await part(refusedRig);
    expect(refused).toMatchObject({ ok: false, refusal: { code: 'signature-refused' } });
    expect(refusedRig.calls).toEqual([]);

    const signed = (
      await referenceSign(
        {
          method: 'PUT',
          path: OBJECT_PATH,
          query: { 'x-id': 'UploadPart', partNumber: '1', uploadId: UPLOAD_ID },
          headers: { ...SDK_HEADERS, 'content-length': '4' },
          payloadHash: sha256('PART'),
        },
        IDENTITY
      )
    ).request;
    const reason = await makeVerifier().verifyDetailed({
      ...withHeaders(signed, stray),
      bodySha256: sha256('PART'),
    });
    expect(reason).toMatchObject({ ok: false, reason: 'amz-header-unsigned' });

    // Admission skipped: the request goes straight to the upstream stage with the stray headers on it.
    const request = withHeaders({ ...signed, bodySha256: sha256('PART') }, stray);
    const routed = routeRequest(request);
    if (!routed.ok) throw new Error('the part must route');
    const sentHeaders: Record<string, string>[] = [];
    const direct = createUpstream({
      endpoint: 'https://nbg1.storage.invalid',
      region: REGION,
      credentials: new UpstreamCredentials(REAL_KEY_ID, REAL_SECRET),
      deadlineMs: 5000,
      now: () => FIXED_NOW,
      transport: async (req) => {
        sentHeaders.push({ ...req.headers });
        return { status: 200, headers: {}, body: Readable.from([]) };
      },
    });
    await direct.forward({
      request,
      route: routed.route,
      tenant: { keyId: KEY_ID, folder: FOLDER, bucket: BUCKET },
      body: { sha256: sha256('PART'), size: 4, open: () => Readable.from([Buffer.from('PART')]) },
    });
    expect(sentHeaders).toHaveLength(1);
    expect(Object.keys(sentHeaders[0] ?? {}).filter(isChecksumHeader)).toEqual([]);
  });
});

describe('multipart complete: a client that signed x-amz-checksum-crc32 on the parts', () => {
  const client: Client = {
    signPartCrc32: true,
    completeNamesCrc32: true,
    extraSigned: { 'x-amz-expected-bucket-owner': 'TEST_OWNER' },
  };

  it('is forwarded as the allowlist says: checksum headers pass, every other signed header outside it is dropped', async () => {
    const rig = makeRig();
    const upload = await uploadTwelveMiB(rig, client);

    expect(rig.refusals).toEqual([]);
    expect(rig.calls.map(label)).toEqual(SEQUENCE);
    expect(answerOf(upload.completeSent).status).toBe(200);

    const [create, p1, p2, p3, complete] = rig.calls as [Call, Call, Call, Call, Call];
    // Passed: the checksum headers of the create and of each part, as signed.
    expect(wireNames(create)).toEqual(withNames('x-amz-checksum-algorithm', 'x-amz-checksum-type'));
    expect(create.headers['x-amz-checksum-algorithm']).toBe('CRC32');
    for (const [i, part] of [p1, p2, p3].entries()) {
      expect(wireNames(part)).toEqual(
        withNames('x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm')
      );
      expect(part.headers['x-amz-checksum-crc32']).toBe(upload.crcs[i]);
      expect(part.headers['x-amz-sdk-checksum-algorithm']).toBe('CRC32');
    }
    // Passed: content-type on the complete. Nothing checksum-shaped is added to it.
    expect(wireNames(complete)).toEqual(withNames('content-type'));
    // Dropped: the SDK headers the gateway owns, and a signed x-amz header the allowlist does not name.
    for (const call of rig.calls) {
      expect(call.headers['x-amz-expected-bucket-owner']).toBeUndefined();
      expect(call.headers['user-agent']).toBeUndefined();
      expect(call.headers['amz-sdk-invocation-id']).toBeUndefined();
      expect(await signedByRealKey(call)).toBe(true);
    }
  });

  it('passes the complete document through byte for byte, ChecksumCRC32 elements included, and relays the part checksum back', async () => {
    const rig = makeRig();
    const upload = await uploadTwelveMiB(rig, client);
    const complete = rig.calls.at(-1) as Call;

    expect(complete.bodyText).toBe(upload.completeXml);
    expect(complete.bodyText.match(/<ChecksumCRC32>/g)).toHaveLength(3);
    expect(complete.bodySha256).toBe(sha256(upload.completeXml));
    expect(upload.partAnswers.map((a) => a.headers['x-amz-checksum-crc32'])).toEqual([
      ...upload.crcs,
    ]);
    expect(rig.calls.slice(1, 4).map((c) => c.bodySha256)).toEqual(upload.parts.map(sha256));
  });
});

describe('multipart complete: parts uploaded with a CRC32, then a complete that names none', () => {
  const stripped: Client = { signPartCrc32: true, completeNamesCrc32: false };

  /*
   * The gateway does not read the complete document and holds no checksum
   * rule of its own, so it neither refuses nor repairs this sequence: the
   * complete reaches the storage service exactly as the client wrote it, and
   * the answer is the storage service's. The two replies below are scripted
   * stand-ins to record each case; neither is a measurement of Hetzner.
   */
  it('forwards the stripped complete untouched and returns the storage service 200 as it is', async () => {
    const rig = makeRig();
    const upload = await uploadTwelveMiB(rig, stripped);
    const [, p1, p2, p3, complete] = rig.calls as [Call, Call, Call, Call, Call];

    for (const part of [p1, p2, p3]) expect(part.headers['x-amz-checksum-crc32']).toBeDefined();
    expect(complete.bodyText).toBe(upload.completeXml);
    expect(complete.bodyText).not.toMatch(/Checksum/);
    expect(Object.keys(complete.headers).filter(isChecksumHeader)).toEqual([]);

    const answer = answerOf(upload.completeSent);
    expect(answer.status).toBe(200);
    expect(answer.refusal).toBeUndefined();
    expect(rig.refusals).toEqual([]);
    expect(rig.upstreamLogs.at(-1)).toMatchObject({
      outcome: 'ok',
      operation: 'CompleteMultipartUpload',
      status: 200,
    });
    expect(
      rig.uploads.isBound(UPLOAD_ID, { keyId: KEY_ID, bucket: BUCKET, key: `${FOLDER}/big.bin` })
    ).toBe(false);
  });

  it('relays a scripted storage-service refusal as its status and S3 code, once, and keeps the upload bound for a retry', async () => {
    // Stand-in rule: refuse a complete that names no checksum after parts that carried one.
    const refuseStripped: Script = (call, earlier) => {
      if (
        isComplete(call) &&
        earlier.some((c) => c.headers['x-amz-checksum-crc32'] !== undefined) &&
        !call.bodyText.includes('<ChecksumCRC32>')
      ) {
        return {
          status: 400,
          headers: { 'content-type': 'application/xml' },
          body: '<Error><Code>InvalidRequest</Code><Message>SCRIPTED_STAND_IN</Message></Error>',
        };
      }
      return acceptAll(call, earlier);
    };
    const rig = makeRig(refuseStripped);
    const upload = await uploadTwelveMiB(rig, stripped);

    const answer = answerOf(upload.completeSent);
    expect(answer.status).toBe(400);
    expect(answer.refusal).toBeUndefined();
    expect(String(answer.body)).toContain('<Code>InvalidRequest</Code>');
    expect(String(answer.body)).not.toContain('SCRIPTED_STAND_IN');
    expect(rig.calls.filter(isComplete)).toHaveLength(1);
    expect(rig.upstreamLogs.at(-1)).toMatchObject({
      outcome: 'upstream-error',
      status: 400,
      attempts: 1,
    });
    expect(rig.refusals).toEqual([]);
    expect(
      rig.uploads.isBound(UPLOAD_ID, { keyId: KEY_ID, bucket: BUCKET, key: `${FOLDER}/big.bin` })
    ).toBe(true);
  });
});
