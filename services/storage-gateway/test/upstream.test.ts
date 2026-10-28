import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { inspect } from 'node:util';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayRequest } from '../src/contracts.js';
import { routeRequest, type RoutedRequest } from '../src/router.js';
import { SigV4Verifier } from '../src/sigv4-verifier.js';
import { createInMemoryUploadBindings } from '../src/uploads.js';
import {
  UpstreamCredentials,
  createUpstream,
  type UpstreamAnswer,
  type UpstreamBody,
  type UpstreamLogEntry,
  type UpstreamOptions,
} from '../src/upstream.js';
import { referenceSign, sha256Hex, type SignSpec } from './support/reference-signer.js';
import {
  IDENTITY,
  KEY_ID,
  REGION,
  SIGNING_DATE,
  withHeaders,
} from './support/verifier-fixtures.js';

const REAL_KEY_ID = 'REALHETZNERKEYID01';
const REAL_SECRET = 'REAL_SECRET_MUST_NEVER_APPEAR';
const BUCKET = 'media-shard-a';
const FOLDER = 'q7f3k2m9x1';
const TENANT = { keyId: KEY_ID, folder: FOLDER, bucket: BUCKET };
const HOST = 'storage-gateway.internal:8443';
const PAYLOAD = 'IMAGE_BYTES_PLACEHOLDER';
const FIXED_NOW = SIGNING_DATE.getTime();

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

interface Double {
  readonly origin: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

type Handler = (seen: Seen, res: ServerResponse, hit: number) => void;

const doubles: Double[] = [];

afterEach(async () => {
  await Promise.all(doubles.splice(0).map((d) => d.close()));
});

async function startDouble(handler: Handler, readBody = true): Promise<Double> {
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    const respond = (): void => {
      const one: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      seen.push(one);
      handler(one, res, seen.length);
    };
    if (!readBody) return respond();
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', respond);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const double: Double = {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  doubles.push(double);
  return double;
}

/** The storage service as the real one behaves: it verifies the signature against the real key only. */
const realKeyVerifier = new SigV4Verifier({
  region: REGION,
  secrets: { signingSecret: async (id) => (id === REAL_KEY_ID ? REAL_SECRET : undefined) },
  now: () => FIXED_NOW,
});

async function signatureAccepted(seen: Seen): Promise<boolean> {
  const headers: Record<string, string | string[] | undefined> = { ...seen.headers };
  const request: GatewayRequest = {
    method: seen.method,
    rawTarget: seen.url,
    headers,
    bodySha256: sha256Hex(seen.body.toString('utf8')),
  };
  return (await realKeyVerifier.verify(request)).ok;
}

const ok200 = (res: ServerResponse): void => {
  res.writeHead(200, { etag: '"abc"', 'x-amz-request-id': 'REQ1', 'set-cookie': 'leak=1' });
  res.end();
};

const body = (text: string): UpstreamBody => ({
  sha256: sha256Hex(text),
  size: Buffer.byteLength(text),
  open: () => Readable.from([Buffer.from(text)]),
});

const PUT: SignSpec = {
  method: 'PUT',
  path: `/${BUCKET}/${FOLDER}/photo%201.png`,
  query: { 'x-id': 'PutObject' },
  headers: {
    host: HOST,
    'content-type': 'image/png',
    'content-length': String(PAYLOAD.length),
    'x-amz-checksum-crc32': 'NSRBwg==',
    'x-amz-sdk-checksum-algorithm': 'CRC32',
    'user-agent': 'TENANT_SDK_AGENT',
  },
  body: PAYLOAD,
  payloadHash: sha256Hex(PAYLOAD),
};

const GET: SignSpec = {
  method: 'GET',
  path: `/${BUCKET}/${FOLDER}/photo.png`,
  query: { 'x-id': 'GetObject' },
  headers: { host: HOST },
};

const HEAD: SignSpec = { ...GET, method: 'HEAD', query: {} };

interface Prepared {
  readonly request: GatewayRequest;
  readonly route: RoutedRequest;
}

async function prepare(
  spec: SignSpec,
  tweak?: (r: GatewayRequest) => GatewayRequest
): Promise<Prepared> {
  const signed = (await referenceSign(spec, IDENTITY)).request;
  const request = tweak === undefined ? signed : tweak(signed);
  const routed = routeRequest(request);
  if (!routed.ok) throw new Error('test request must route');
  return { request, route: routed.route };
}

interface Rig {
  readonly logs: UpstreamLogEntry[];
  readonly options: (double: Double, extra?: Partial<UpstreamOptions>) => UpstreamOptions;
}

function rig(): Rig {
  const logs: UpstreamLogEntry[] = [];
  return {
    logs,
    options: (double, extra = {}) => ({
      endpoint: double.origin,
      region: REGION,
      credentials: new UpstreamCredentials(REAL_KEY_ID, REAL_SECRET),
      deadlineMs: 2000,
      now: () => FIXED_NOW,
      logger: { upstream: (e) => logs.push(e) },
      ...extra,
    }),
  };
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** Rejects with a clear message instead of hanging the test when the gateway does not answer. */
async function answerWithin(promise: Promise<UpstreamAnswer>, ms: number): Promise<UpstreamAnswer> {
  let timer: NodeJS.Timeout | undefined;
  const never = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, never]);
  } finally {
    clearTimeout(timer);
  }
}

describe('upstream: re-signing with the real key', () => {
  it('sends an upload the storage service verifies against the real key alone', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const r = rig();
    const up = createUpstream(r.options(double));
    const { request, route } = await prepare(PUT);

    const answer = await up.forward({ request, route, tenant: TENANT, body: body(PAYLOAD) });

    expect(answer.status).toBe(200);
    expect(double.seen).toHaveLength(1);
    const seen = double.seen[0] as Seen;
    expect(await signatureAccepted(seen)).toBe(true);
    expect(seen.body.toString('utf8')).toBe(PAYLOAD);
    expect(String(seen.headers.authorization)).toContain(`Credential=${REAL_KEY_ID}/`);
  });

  it('refuses to sign an upload whose signature the tenant key made, proving the check is the real key', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const { request, route } = await prepare(PUT);
    await up.forward({ request, route, tenant: TENANT, body: body(PAYLOAD) });
    const seen = double.seen[0] as Seen;
    const asTenant = new SigV4Verifier({
      region: REGION,
      secrets: { signingSecret: async (id) => (id === KEY_ID ? 'x' : undefined) },
      now: () => FIXED_NOW,
    });
    const verdict = await asTenant.verify({
      method: seen.method,
      rawTarget: seen.url,
      headers: { ...seen.headers },
      bodySha256: sha256Hex(PAYLOAD),
    });
    expect(verdict.ok).toBe(false);
  });

  it('rebuilds the target from the routed request, not the client target', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const { request, route } = await prepare(PUT);
    await up.forward({ request, route, tenant: TENANT, body: body(PAYLOAD) });
    expect((double.seen[0] as Seen).url).toBe(`/${BUCKET}/${FOLDER}/photo%201.png`);
  });

  it('forwards a header only when the client signed it and the allowlist admits it', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const unsigned = await prepare(
      { ...PUT, headers: { ...PUT.headers, 'content-type': undefined as never } },
      (r) => withHeaders(r, { 'content-type': 'text/html', 'cache-control': 'public' })
    );
    await up.forward({ ...unsigned, tenant: TENANT, body: body(PAYLOAD) });
    const first = double.seen[0] as Seen;
    expect(first.headers['content-type']).toBeUndefined();
    expect(first.headers['cache-control']).toBeUndefined();

    const signed = await prepare(PUT);
    await up.forward({ ...signed, tenant: TENANT, body: body(PAYLOAD) });
    const second = double.seen[1] as Seen;
    expect(second.headers['content-type']).toBe('image/png');
    expect(second.headers['x-amz-checksum-crc32']).toBe('NSRBwg==');
    expect(second.headers['user-agent']).not.toBe('TENANT_SDK_AGENT');
    expect(await signatureAccepted(second)).toBe(true);
  });

  it('never sends the tenant key or its signature upstream', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const { request, route } = await prepare(PUT);
    await up.forward({ request, route, tenant: TENANT, body: body(PAYLOAD) });
    const wire = JSON.stringify((double.seen[0] as Seen).headers);
    expect(wire).not.toContain(KEY_ID);
    expect(wire).not.toContain(String(request.headers.authorization).split('Signature=')[1]);
  });

  it('signs a read and an existence check the same way', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '5' });
      res.end('bytes');
    });
    const up = createUpstream(rig().options(double));
    const read = await prepare(GET);
    const answer = await up.forward({ ...read, tenant: TENANT });
    expect(answer.status).toBe(200);
    expect(await readAll(answer.body as Readable)).toBe('bytes');
    expect(answer.headers['content-type']).toBe('image/png');
    const head = await prepare(HEAD);
    const headAnswer = await up.forward({ ...head, tenant: TENANT });
    expect(headAnswer.status).toBe(200);
    for (const seen of double.seen) expect(await signatureAccepted(seen)).toBe(true);
  });

  it('does not relay headers the gateway did not choose', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const { request, route } = await prepare(PUT);
    const answer = await up.forward({ request, route, tenant: TENANT, body: body(PAYLOAD) });
    expect(answer.headers.etag).toBe('"abc"');
    expect(answer.headers['set-cookie']).toBeUndefined();
  });
});

describe('upstream: multipart uploads', () => {
  const CREATE: SignSpec = {
    method: 'POST',
    path: `/${BUCKET}/${FOLDER}/big.bin`,
    query: { uploads: '' },
    headers: { host: HOST },
    body: '',
    payloadHash: sha256Hex(''),
  };
  const part = (uploadId: string): SignSpec => ({
    method: 'PUT',
    path: `/${BUCKET}/${FOLDER}/big.bin`,
    query: { partNumber: '1', uploadId },
    headers: { host: HOST, 'content-length': String(PAYLOAD.length) },
    body: PAYLOAD,
    payloadHash: sha256Hex(PAYLOAD),
  });
  const COMPLETE_BODY = '<CompleteMultipartUpload/>';
  const complete = (uploadId: string): SignSpec => ({
    method: 'POST',
    path: `/${BUCKET}/${FOLDER}/big.bin`,
    query: { uploadId },
    headers: { host: HOST, 'content-length': String(COMPLETE_BODY.length) },
    body: COMPLETE_BODY,
    payloadHash: sha256Hex(COMPLETE_BODY),
  });
  const abort = (uploadId: string): SignSpec => ({
    method: 'DELETE',
    path: `/${BUCKET}/${FOLDER}/big.bin`,
    query: { uploadId },
    headers: { host: HOST },
  });

  const binding = { keyId: KEY_ID, bucket: BUCKET, key: `${FOLDER}/big.bin` };

  const lifecycle = (completeAnswer: string) =>
    startDouble((seen, res) => {
      if (seen.method === 'POST' && seen.url.includes('uploads')) {
        res.writeHead(200);
        res.end(
          '<InitiateMultipartUploadResult><UploadId>UP&amp;1</UploadId></InitiateMultipartUploadResult>'
        );
      } else if (seen.method === 'POST') {
        res.writeHead(200);
        res.end(completeAnswer);
      } else if (seen.method === 'DELETE') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(200, { etag: '"p1"' });
        res.end();
      }
    });

  it('binds the upload id on create and releases it on complete', async () => {
    const double = await lifecycle('<CompleteMultipartUploadResult/>');
    const uploads = createInMemoryUploadBindings();
    const up = createUpstream(rig().options(double, { uploads }));

    const created = await prepare(CREATE);
    const createAnswer = await up.forward({
      ...created,
      tenant: TENANT,
      body: body(''),
    });
    expect(createAnswer.status).toBe(200);
    expect(String(createAnswer.body)).toContain('UP&amp;1');
    expect(uploads.isBound('UP&1', binding)).toBe(true);

    const partReq = await prepare(part('UP&1'));
    expect((await up.forward({ ...partReq, tenant: TENANT, body: body(PAYLOAD) })).status).toBe(
      200
    );
    const done = await prepare(complete('UP&1'));
    const doneAnswer = await up.forward({ ...done, tenant: TENANT, body: body(COMPLETE_BODY) });
    expect(doneAnswer.status).toBe(200);
    expect(uploads.isBound('UP&1', binding)).toBe(false);
    for (const seen of double.seen) expect(await signatureAccepted(seen)).toBe(true);
  });

  it('releases the id on abort', async () => {
    const double = await lifecycle('<x/>');
    const uploads = createInMemoryUploadBindings();
    uploads.bind('UP1', binding);
    const up = createUpstream(rig().options(double, { uploads }));
    const aborted = await prepare(abort('UP1'));
    expect((await up.forward({ ...aborted, tenant: TENANT })).status).toBe(204);
    expect(uploads.isBound('UP1', binding)).toBe(false);
  });

  it('treats a complete that answers 200 with an error document as a retryable failure', async () => {
    const double = await lifecycle('<Error><Code>InternalError</Code></Error>');
    const uploads = createInMemoryUploadBindings();
    uploads.bind('UP1', binding);
    const up = createUpstream(rig().options(double, { uploads }));
    const done = await prepare(complete('UP1'));
    const answer = await up.forward({ ...done, tenant: TENANT, body: body(COMPLETE_BODY) });
    expect(answer.status).toBe(500);
    expect(String(answer.body)).toContain('<Code>InternalError</Code>');
    expect(uploads.isBound('UP1', binding)).toBe(true);
  });

  it('fails a create it cannot bind rather than leaving an upload no one can finish', async () => {
    const double = await lifecycle('<x/>');
    const uploads = createInMemoryUploadBindings({ limit: 0 });
    const up = createUpstream(rig().options(double, { uploads }));
    const created = await prepare(CREATE);
    const answer = await up.forward({ ...created, tenant: TENANT, body: body('') });
    expect(answer.status).toBe(503);
    expect(answer.refusal?.code).toBe('upstream-unavailable');
  });

  it('fails a create whose answer carries no upload id', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(200);
      res.end('<InitiateMultipartUploadResult/>');
    });
    const up = createUpstream(rig().options(double, { uploads: createInMemoryUploadBindings() }));
    const created = await prepare(CREATE);
    const answer = await up.forward({ ...created, tenant: TENANT, body: body('') });
    expect(answer.refusal?.code).toBe('upstream-unavailable');
  });
});

describe('upstream: guards before the key is used', () => {
  it('sends nothing for an object name outside the tenant folder', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const { request, route } = await prepare(PUT);
    const answer = await up.forward({
      request,
      route,
      tenant: { ...TENANT, folder: 'another0000' },
      body: body(PAYLOAD),
    });
    expect(answer.refusal?.code).toBe('key-outside-folder');
    expect(double.seen).toHaveLength(0);
  });

  it('sends nothing for another bucket', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const { request, route } = await prepare(PUT);
    const answer = await up.forward({
      request,
      route,
      tenant: { ...TENANT, bucket: 'media-shard-b' },
      body: body(PAYLOAD),
    });
    expect(answer.refusal?.code).toBe('key-outside-folder');
    expect(double.seen).toHaveLength(0);
  });

  it('sends nothing when the body is not the one whose digest was checked', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const { request, route } = await prepare(PUT);
    const swapped = body('OTHER_BYTES_PLACEHOLDER');
    const answer = await up.forward({ request, route, tenant: TENANT, body: swapped });
    expect(answer.refusal?.code).toBe('internal-error');
    expect(double.seen).toHaveLength(0);
  });

  it('sends nothing when an upload has no body or a read has one', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const put = await prepare(PUT);
    expect((await up.forward({ ...put, tenant: TENANT })).refusal?.code).toBe('internal-error');
    const get = await prepare(GET);
    const answer = await up.forward({ ...get, tenant: TENANT, body: body(PAYLOAD) });
    expect(answer.refusal?.code).toBe('internal-error');
    expect(double.seen).toHaveLength(0);
  });

  it('sends nothing when the request method does not match the routed operation', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const get = await prepare(GET);
    const answer = await up.forward({
      request: { ...get.request, method: 'DELETE' },
      route: get.route,
      tenant: TENANT,
    });
    expect(answer.refusal?.code).toBe('internal-error');
    expect(double.seen).toHaveLength(0);
  });

  it('sends nothing for a signed header value that is not plain text', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const up = createUpstream(rig().options(double));
    const odd = await prepare(PUT, (r) =>
      withHeaders(r, { 'content-type': 'image/png\r\nx-evil: 1' })
    );
    const answer = await up.forward({ ...odd, tenant: TENANT, body: body(PAYLOAD) });
    expect(answer.refusal?.code).toBe('target-malformed');
    expect(double.seen).toHaveLength(0);
  });
});

describe('upstream: errors come back in a form the client understands', () => {
  it('relays the S3 code and status and nothing else the service wrote', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(403, { 'content-type': 'application/xml', location: 'https://leak.invalid' });
      res.end(
        `<Error><Code>AccessDenied</Code><Message>no</Message><Key>${FOLDER}/photo.png</Key>` +
          `<BucketName>${BUCKET}</BucketName><AWSAccessKeyId>${REAL_KEY_ID}</AWSAccessKeyId></Error>`
      );
    });
    const up = createUpstream(rig().options(double));
    const get = await prepare(GET);
    const answer = await up.forward({ ...get, tenant: TENANT });
    expect(answer.status).toBe(403);
    const text = JSON.stringify(answer);
    expect(text).toContain('AccessDenied');
    for (const secret of [REAL_KEY_ID, FOLDER, BUCKET, 'leak.invalid']) {
      expect(text).not.toContain(secret);
    }
  });

  it('gives an existence check a bare status, as HEAD has no body', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(404);
      res.end();
    });
    const up = createUpstream(rig().options(double));
    const head = await prepare(HEAD);
    const answer = await up.forward({ ...head, tenant: TENANT });
    expect(answer).toEqual({ status: 404, headers: {} });
  });

  it('replaces an error without a parsable code by a generic one for its class', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(500);
      res.end('<html>not xml</html>');
    });
    const up = createUpstream(rig().options(double));
    const get = await prepare(GET);
    const answer = await up.forward({ ...get, tenant: TENANT });
    expect(answer.status).toBe(500);
    expect(String(answer.body)).toContain('<Code>InternalError</Code>');
  });

  it('does not follow or relay a redirect', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(301, { location: 'https://elsewhere.invalid/x' });
      res.end();
    });
    const up = createUpstream(rig().options(double));
    const get = await prepare(GET);
    const answer = await up.forward({ ...get, tenant: TENANT });
    expect(answer.refusal?.code).toBe('upstream-unavailable');
    expect(JSON.stringify(answer)).not.toContain('elsewhere');
    expect(double.seen).toHaveLength(1);
  });

  it('passes a not-modified answer on', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(304);
      res.end();
    });
    const up = createUpstream(rig().options(double));
    const get = await prepare(GET);
    const answer = await up.forward({ ...get, tenant: TENANT });
    expect(answer.status).toBe(304);
  });

  it('answers unavailable, retryably, when the service cannot be reached', async () => {
    const double = await startDouble((_, res) => ok200(res));
    const options = rig().options(double);
    await double.close();
    const up = createUpstream(options);
    const get = await prepare(GET);
    const answer = await up.forward({ ...get, tenant: TENANT });
    expect(answer.status).toBe(503);
    expect(answer.refusal?.code).toBe('upstream-unavailable');
  });
});

describe('upstream: the deadline', () => {
  it('answers a retryable timeout when the service accepts a request and never answers', async () => {
    const double = await startDouble(() => undefined);
    const r = rig();
    const up = createUpstream(r.options(double, { deadlineMs: 150 }));
    const { request, route } = await prepare(PUT);

    const started = Date.now();
    const answer = await answerWithin(
      up.forward({ request, route, tenant: TENANT, body: body(PAYLOAD) }),
      3000
    );

    expect(Date.now() - started).toBeLessThan(1500);
    expect(answer.status).toBe(504);
    expect(answer.refusal?.code).toBe('upstream-timeout');
    expect(String(answer.body)).toContain('<Code>RequestTimeout</Code>');
    expect(r.logs.at(-1)?.outcome).toBe('timeout');
  });

  it('answers a timeout when the service takes the request but never reads the body', async () => {
    const double = await startDouble(() => undefined, false);
    const up = createUpstream(rig().options(double, { deadlineMs: 150 }));
    const get = await prepare(GET);
    const answer = await answerWithin(up.forward({ ...get, tenant: TENANT }), 3000);
    expect(answer.refusal?.code).toBe('upstream-timeout');
  });

  it('cuts a streamed read that goes quiet part way', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('part');
    });
    const up = createUpstream(rig().options(double, { deadlineMs: 2000, idleTimeoutMs: 100 }));
    const get = await prepare(GET);
    const answer = await answerWithin(up.forward({ ...get, tenant: TENANT }), 3000);
    expect(answer.status).toBe(200);
    await expect(readAll(answer.body as Readable)).rejects.toThrow();
  });

  it('does not apply the call deadline to a read that keeps arriving', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(200);
      let sent = 0;
      const tick = setInterval(() => {
        res.write('x');
        sent += 1;
        if (sent === 8) {
          clearInterval(tick);
          res.end();
        }
      }, 40);
    });
    const up = createUpstream(rig().options(double, { deadlineMs: 150, idleTimeoutMs: 500 }));
    const get = await prepare(GET);
    const answer = await answerWithin(up.forward({ ...get, tenant: TENANT }), 3000);
    expect(await readAll(answer.body as Readable)).toBe('xxxxxxxx');
  });

  it('stops the upstream call when the client goes away', async () => {
    const double = await startDouble(() => undefined);
    const up = createUpstream(rig().options(double, { deadlineMs: 5000 }));
    const get = await prepare(GET);
    const controller = new AbortController();
    const pending = up.forward({ ...get, tenant: TENANT, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const answer = await answerWithin(pending, 2000);
    expect(answer.refusal?.code).toBe('upstream-unavailable');
  });

  it('rejects a deadline that is not a positive number', () => {
    const base = { endpoint: 'http://127.0.0.1:1', region: REGION };
    const credentials = new UpstreamCredentials(REAL_KEY_ID, REAL_SECRET);
    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createUpstream({ ...base, credentials, deadlineMs })).toThrow(RangeError);
    }
  });
});

describe('upstream: the storage service asks the gateway to slow down', () => {
  const slowThenOk =
    (slow: number, status = 503) =>
    (_: Seen, res: ServerResponse, hit: number): void => {
      if (hit <= slow) {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end('<Error><Code>SlowDown</Code></Error>');
      } else {
        ok200(res);
      }
    };

  it('retries with jittered exponential backoff and then succeeds', async () => {
    const double = await startDouble(slowThenOk(3));
    const sleeps: number[] = [];
    const r = rig();
    const up = createUpstream(
      r.options(double, {
        random: () => 0.5,
        backoff: { baseMs: 100, maxMs: 250 },
        sleep: async (ms) => void sleeps.push(ms),
      })
    );
    const { request, route } = await prepare(PUT);
    const answer = await up.forward({ request, route, tenant: TENANT, body: body(PAYLOAD) });

    expect(answer.status).toBe(200);
    expect(sleeps).toEqual([50, 100, 125]);
    expect(double.seen).toHaveLength(4);
    expect(r.logs.at(-1)).toMatchObject({ outcome: 'ok', attempts: 4 });
    for (const seen of double.seen) {
      expect(seen.body.toString('utf8')).toBe(PAYLOAD);
      expect(await signatureAccepted(seen)).toBe(true);
    }
  });

  it('retries a 429 too', async () => {
    const double = await startDouble(slowThenOk(1, 429));
    const up = createUpstream(rig().options(double, { sleep: async () => undefined }));
    const get = await prepare(GET);
    expect((await up.forward({ ...get, tenant: TENANT })).status).toBe(200);
    expect(double.seen).toHaveLength(2);
  });

  it('keeps retrying inside the deadline and then answers a retryable slow-down, not a hard failure', async () => {
    const double = await startDouble(slowThenOk(Number.MAX_SAFE_INTEGER));
    const r = rig();
    const up = createUpstream(
      r.options(double, {
        now: Date.now,
        deadlineMs: 400,
        maxAttempts: 1000,
        random: () => 0.99,
        backoff: { baseMs: 20, maxMs: 40 },
      })
    );
    const get = await prepare(GET);
    const started = Date.now();
    const answer = await answerWithin(up.forward({ ...get, tenant: TENANT }), 3000);

    expect(Date.now() - started).toBeLessThan(900);
    expect(answer.status).toBe(503);
    expect(answer.refusal?.code).toBe('upstream-throttled');
    expect(String(answer.body)).toContain('<Code>SlowDown</Code>');
    expect(double.seen.length).toBeGreaterThan(3);
    expect(r.logs.at(-1)?.outcome).toBe('throttled');
  });

  it('answers at once when the next backoff would run past the deadline', async () => {
    const double = await startDouble(slowThenOk(Number.MAX_SAFE_INTEGER));
    const slept: number[] = [];
    const up = createUpstream(
      rig().options(double, {
        deadlineMs: 1000,
        random: () => 0.99,
        backoff: { baseMs: 5000, maxMs: 5000 },
        sleep: async (ms) => void slept.push(ms),
      })
    );
    const get = await prepare(GET);
    const answer = await up.forward({ ...get, tenant: TENANT });
    expect(answer.refusal?.code).toBe('upstream-throttled');
    expect(slept).toEqual([]);
    expect(double.seen).toHaveLength(1);
  });

  it('stops after the attempt limit', async () => {
    const double = await startDouble(slowThenOk(Number.MAX_SAFE_INTEGER));
    const up = createUpstream(
      rig().options(double, { maxAttempts: 3, sleep: async () => undefined })
    );
    const get = await prepare(GET);
    const answer = await up.forward({ ...get, tenant: TENANT });
    expect(answer.refusal?.code).toBe('upstream-throttled');
    expect(double.seen).toHaveLength(3);
  });

  it('does not retry other server errors', async () => {
    const double = await startDouble((_, res) => {
      res.writeHead(500);
      res.end('<Error><Code>InternalError</Code></Error>');
    });
    const up = createUpstream(rig().options(double, { sleep: async () => undefined }));
    const get = await prepare(GET);
    expect((await up.forward({ ...get, tenant: TENANT })).status).toBe(500);
    expect(double.seen).toHaveLength(1);
  });

  it('stops waiting between attempts when the deadline passes during the wait', async () => {
    const double = await startDouble(slowThenOk(Number.MAX_SAFE_INTEGER));
    const up = createUpstream(
      rig().options(double, {
        deadlineMs: 100,
        random: () => 0.5,
        backoff: { baseMs: 150, maxMs: 150 },
        now: () => FIXED_NOW,
      })
    );
    const get = await prepare(GET);
    const answer = await answerWithin(up.forward({ ...get, tenant: TENANT }), 2000);
    expect(['upstream-timeout', 'upstream-throttled']).toContain(answer.refusal?.code);
  });
});

describe('upstream: the real key stays secret', () => {
  it('never appears in the credential object when printed, logged or serialised', () => {
    const credentials = new UpstreamCredentials(REAL_KEY_ID, REAL_SECRET);
    const shown = [
      JSON.stringify(credentials),
      JSON.stringify({ credentials }),
      String(credentials),
      `${credentials}`,
      inspect(credentials, { showHidden: true, depth: 5 }),
      JSON.stringify(Object.getOwnPropertyNames(credentials)),
    ].join('\n');
    expect(shown).not.toContain(REAL_SECRET);
    expect(shown).not.toContain(REAL_KEY_ID);
  });

  it('is removed from any text redact is given', () => {
    const credentials = new UpstreamCredentials(REAL_KEY_ID, REAL_SECRET);
    const text = credentials.redact(`id ${REAL_KEY_ID} secret ${REAL_SECRET} id ${REAL_KEY_ID}`);
    expect(text).not.toContain(REAL_SECRET);
    expect(text).not.toContain(REAL_KEY_ID);
  });

  it('does not appear in an answer, a log entry or the config across success, error and timeout', async () => {
    const mode = { current: 'ok' };
    const double = await startDouble((seen, res) => {
      if (mode.current === 'hang') return;
      if (mode.current === 'echo') {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end(
          `<Error><Code>SignatureDoesNotMatch</Code><AWSAccessKeyId>${REAL_KEY_ID}</AWSAccessKeyId>` +
            `<StringToSign>${String(seen.headers.authorization)}</StringToSign>` +
            `<Secret>${REAL_SECRET}</Secret></Error>`
        );
        return;
      }
      ok200(res);
    });
    const r = rig();
    const options = r.options(double, { deadlineMs: 150 });
    const up = createUpstream(options);
    const answers: UpstreamAnswer[] = [];
    for (const m of ['ok', 'echo', 'hang']) {
      mode.current = m;
      const put = await prepare(PUT);
      answers.push(await up.forward({ ...put, tenant: TENANT, body: body(PAYLOAD) }));
      const get = await prepare(GET);
      answers.push(await up.forward({ ...get, tenant: TENANT }));
    }
    const shown = await Promise.all(
      answers.map(async (a) => ({
        ...a,
        body: a.body instanceof Readable ? await readAll(a.body) : a.body,
      }))
    );
    const everything = JSON.stringify({ shown, logs: r.logs, options });
    expect(everything).not.toContain(REAL_SECRET);
    expect(everything).not.toContain(REAL_KEY_ID);
    expect(r.logs.length).toBeGreaterThanOrEqual(6);
    for (const entry of r.logs) expect(entry.keyId).toBe(KEY_ID);
  });
});

describe('upstream: endpoint', () => {
  const credentials = new UpstreamCredentials(REAL_KEY_ID, REAL_SECRET);
  const make = (endpoint: string) =>
    createUpstream({ endpoint, region: REGION, credentials, deadlineMs: 1000 });

  it('accepts https and loopback http', () => {
    expect(() => make('https://nbg1.storage.invalid')).not.toThrow();
    expect(() => make('http://127.0.0.1:9000')).not.toThrow();
  });

  it('refuses plain http to a host that is not loopback, so the signature never crosses the wire in clear', () => {
    expect(() => make('http://storage.invalid')).toThrow(RangeError);
    expect(() => make('ftp://127.0.0.1')).toThrow(RangeError);
  });

  it('refuses an endpoint that is not a bare origin', () => {
    for (const bad of [
      'https://u:p@storage.invalid',
      'https://storage.invalid/prefix',
      'https://storage.invalid/?a=1',
    ]) {
      expect(() => make(bad)).toThrow(RangeError);
    }
  });

  it('refuses empty credentials', () => {
    expect(() => new UpstreamCredentials('', 'x')).toThrow(RangeError);
    expect(() => new UpstreamCredentials('x', '')).toThrow(RangeError);
  });
});
