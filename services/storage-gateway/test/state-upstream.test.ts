import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { GatewayRequest } from '../src/contracts.js';
import { routeStateRequest, type StateRoutedRequest } from '../src/state-profile.js';
import { createStateUpstream, type StateUpstreamOptions } from '../src/state-upstream.js';
import {
  UpstreamCredentials,
  type UpstreamBody,
  type UpstreamLogEntry,
  type UpstreamTransport,
  type UpstreamTransportRequest,
} from '../src/upstream.js';
import { createHash } from 'node:crypto';

const KEY_ID = 'REALSTATEKEYID0001';
const SECRET = 'REAL_STATE_SECRET_MUST_NEVER_APPEAR';
const BUCKET = 'state-shard-a';
const FOLDER = 'q7f3k2m9x1pref';
const TENANT = { keyId: 'GWTENANT0000000000000000', folder: FOLDER, bucket: BUCKET };
const EMPTY = createHash('sha256').digest('hex');
const SIGNED =
  'AWS4-HMAC-SHA256 Credential=x/20260101/r/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date';

interface Reply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

function harness(replies: Reply[], extra: Partial<StateUpstreamOptions> = {}) {
  const calls: UpstreamTransportRequest[] = [];
  const logs: UpstreamLogEntry[] = [];
  const transport: UpstreamTransport = async (req) => {
    calls.push(req);
    const reply = replies.shift() ?? { status: 200 };
    return {
      status: reply.status,
      headers: reply.headers ?? {},
      body: Readable.from(reply.body === undefined ? [] : [Buffer.from(reply.body)]),
    };
  };
  const upstream = createStateUpstream({
    endpoint: 'https://shard.example.invalid',
    region: 'fsn1',
    bucket: BUCKET,
    credentials: new UpstreamCredentials(KEY_ID, SECRET),
    deadlineMs: 5000,
    transport,
    sleep: async () => undefined,
    random: () => 0,
    now: () => Date.UTC(2026, 10, 18),
    logger: { upstream: (e) => logs.push(e) },
    ...extra,
  });
  return { upstream, calls, logs };
}

const request = (
  method: string,
  rawTarget: string,
  headers: GatewayRequest['headers'] = {},
  bodySha256?: string
): GatewayRequest => ({
  method,
  rawTarget,
  headers: { authorization: SIGNED, ...headers },
  ...(bodySha256 === undefined ? {} : { bodySha256 }),
});

function routed(req: GatewayRequest): StateRoutedRequest {
  const r = routeStateRequest(req);
  if (!r.ok) throw new Error(`route refused: ${r.refusal.code}`);
  return r.route;
}

function bodyOf(text: string): UpstreamBody {
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    size: Buffer.byteLength(text),
    open: () => Readable.from([Buffer.from(text)]),
  };
}

const objectUrl = (rest: string): string => `/${BUCKET}/${FOLDER}/${rest}`;

describe('the state upstream', () => {
  it('signs a read with the shard key and sends the object path, rebuilt from the route', async () => {
    const { upstream, calls } = harness([{ status: 200, body: 'BYTES' }]);
    const req = request('GET', objectUrl('.pulumi/meta.yaml'));
    const answer = await upstream.forward({ request: req, route: routed(req), tenant: TENANT });
    expect(answer.status).toBe(200);
    expect(calls).toHaveLength(1);
    const sent = calls[0] as UpstreamTransportRequest;
    expect(sent.method).toBe('GET');
    expect(sent.url.pathname).toBe(objectUrl('.pulumi/meta.yaml'));
    expect(sent.headers.authorization).toContain(`Credential=${KEY_ID}/`);
    expect(JSON.stringify(sent.headers)).not.toContain(SECRET);
  });

  it('sends a listing with the tenant prefix, sorted, and never the owner request or the SDK marker', async () => {
    const { upstream, calls } = harness([{ status: 200, body: '<ListBucketResult/>' }]);
    const target = `/${BUCKET}?list-type=2&prefix=${FOLDER}%2F.pulumi%2F&fetch-owner=true&x-id=ListObjectsV2&delimiter=%2F&max-keys=50`;
    const req = request('GET', target);
    const answer = await upstream.forward({ request: req, route: routed(req), tenant: TENANT });
    expect(answer.status).toBe(200);
    const url = (calls[0] as UpstreamTransportRequest).url;
    expect(url.pathname).toBe(`/${BUCKET}`);
    expect(url.search).toBe(`?delimiter=%2F&list-type=2&max-keys=50&prefix=${FOLDER}%2F.pulumi%2F`);
  });

  it('writes an object with the digest of the bytes it sends', async () => {
    const { upstream, calls } = harness([{ status: 200, headers: { etag: '"e"' } }]);
    const body = bodyOf('{"checkpoint":1}');
    const req = request('PUT', objectUrl('.pulumi/stacks/p/s.json'), {}, body.sha256);
    await upstream.forward({ request: req, route: routed(req), tenant: TENANT, body });
    const sent = calls[0] as UpstreamTransportRequest;
    expect(sent.headers['x-amz-content-sha256']).toBe(body.sha256);
    expect(sent.headers['content-length']).toBe(String(body.size));
  });

  it('builds the copy source itself from the admitted route, not from the client header', async () => {
    const { upstream, calls } = harness([{ status: 200, body: '<CopyObjectResult/>' }]);
    const req = request(
      'PUT',
      objectUrl('.pulumi/backups/b.json'),
      {
        'x-amz-copy-source': `/${BUCKET}/${FOLDER}/.pulumi/stacks/a%20b.json`,
      },
      EMPTY
    );
    const answer = await upstream.forward({ request: req, route: routed(req), tenant: TENANT });
    expect(answer.status).toBe(200);
    expect((calls[0] as UpstreamTransportRequest).headers['x-amz-copy-source']).toBe(
      `/${BUCKET}/${FOLDER}/.pulumi/stacks/a%20b.json`
    );
  });

  it('answers a copy that the shard answered 200 with an error document as a failure', async () => {
    const { upstream } = harness([
      {
        status: 200,
        body: '<Error><Code>InternalError</Code><Message>' + SECRET + '</Message></Error>',
      },
    ]);
    const req = request(
      'PUT',
      objectUrl('.pulumi/backups/b.json'),
      {
        'x-amz-copy-source': `/${BUCKET}/${FOLDER}/.pulumi/stacks/a.json`,
      },
      EMPTY
    );
    const answer = await upstream.forward({ request: req, route: routed(req), tenant: TENANT });
    expect(answer.status).toBe(500);
    expect(String(answer.body)).not.toContain(SECRET);
  });

  it('deletes a lock object and relays the answer without a body', async () => {
    const { upstream, calls } = harness([{ status: 204 }]);
    const req = request('DELETE', objectUrl('.pulumi/locks/organization/p/s/1.json'), {}, EMPTY);
    const answer = await upstream.forward({ request: req, route: routed(req), tenant: TENANT });
    expect(answer.status).toBe(204);
    expect((calls[0] as UpstreamTransportRequest).method).toBe('DELETE');
  });

  it('keeps asking when the shard says slow down, then answers a retryable slow-down', async () => {
    const { upstream, calls } = harness(
      Array.from({ length: 6 }, () => ({ status: 503 })),
      { maxAttempts: 3 }
    );
    const req = request('GET', objectUrl('.pulumi/meta.yaml'));
    const answer = await upstream.forward({ request: req, route: routed(req), tenant: TENANT });
    expect(calls).toHaveLength(3);
    expect(answer.status).toBe(503);
    expect(answer.refusal?.code).toBe('upstream-throttled');
  });

  it('never follows a redirect and reduces an upstream error to its code', async () => {
    const redirected = harness([
      { status: 307, headers: { location: 'https://elsewhere.invalid/' } },
    ]);
    const req = request('GET', objectUrl('.pulumi/meta.yaml'));
    const moved = await redirected.upstream.forward({
      request: req,
      route: routed(req),
      tenant: TENANT,
    });
    expect(moved.refusal?.code).toBe('upstream-unavailable');
    expect(redirected.calls).toHaveLength(1);

    const failing = harness([
      {
        status: 403,
        body: `<Error><Code>AccessDenied</Code><Message>${KEY_ID} ${SECRET}</Message></Error>`,
      },
    ]);
    const denied = await failing.upstream.forward({
      request: req,
      route: routed(req),
      tenant: TENANT,
    });
    expect(denied.status).toBe(403);
    expect(String(denied.body)).not.toContain(SECRET);
    expect(String(denied.body)).not.toContain(KEY_ID);
  });

  describe('the fence it re-checks before lending the key', () => {
    const sendsNothing = async (
      route: StateRoutedRequest,
      req: GatewayRequest,
      tenant = TENANT,
      body?: UpstreamBody
    ) => {
      const { upstream, calls, logs } = harness([{ status: 200 }]);
      const answer = await upstream.forward({
        request: req,
        route,
        tenant,
        ...(body === undefined ? {} : { body }),
      });
      expect(calls).toHaveLength(0);
      expect(logs.at(-1)?.outcome).toBe('refused-before-send');
      return answer;
    };

    it('refuses a route outside the tenant prefix, from a caller that skipped admission', async () => {
      const other = request('GET', `/${BUCKET}/otherprefix0000/.pulumi/meta.yaml`);
      const answer = await sendsNothing(routed(other), other);
      expect(answer.refusal?.code).toBe('key-outside-folder');
    });

    it('refuses a delete of anything but a lock', async () => {
      const req = request('DELETE', objectUrl('.pulumi/stacks/p/s.json'), {}, EMPTY);
      const answer = await sendsNothing(routed(req), req);
      expect(answer.refusal?.code).toBe('key-outside-folder');
    });

    it('refuses a listing of the whole bucket', async () => {
      const req = request('GET', `/${BUCKET}?list-type=2&prefix=${FOLDER}%2F`);
      const widened: StateRoutedRequest = { ...routed(req), listPrefix: '' };
      const answer = await sendsNothing(widened, req);
      expect(answer.refusal?.code).toBe('key-outside-folder');
    });

    it('refuses a bucket that is not the one shard, even when the credential names it', async () => {
      const req = request('GET', `/other-shard/${FOLDER}/x`);
      const answer = await sendsNothing(routed(req), req, { ...TENANT, bucket: 'other-shard' });
      expect(answer.refusal?.code).toBe('bucket-not-allowed');
    });

    it('refuses a copy whose source is another tenant’s object', async () => {
      const req = request(
        'PUT',
        objectUrl('.pulumi/backups/b.json'),
        {
          'x-amz-copy-source': `/${BUCKET}/${FOLDER}/.pulumi/stacks/a.json`,
        },
        EMPTY
      );
      const stolen: StateRoutedRequest = {
        ...routed(req),
        copySource: { bucket: BUCKET, key: 'otherprefix0000/.pulumi/stacks/a.json' },
      };
      const answer = await sendsNothing(stolen, req);
      expect(answer.refusal?.code).toBe('key-outside-folder');
    });

    it('refuses a dot segment that URL parsing would collapse out of the prefix', async () => {
      const req = request('GET', objectUrl('.pulumi/meta.yaml'));
      const sneaky: StateRoutedRequest = { ...routed(req), key: `${FOLDER}/a/../../x` };
      const answer = await sendsNothing(sneaky, req);
      expect(answer.refusal?.code).toBe('key-outside-folder');
    });

    it('refuses a body for a read and a missing body for a write', async () => {
      const get = request('GET', objectUrl('.pulumi/meta.yaml'));
      const withBody = await sendsNothing(routed(get), get, TENANT, bodyOf('x'));
      expect(withBody.refusal?.code).toBe('internal-error');
      const put = request('PUT', objectUrl('.pulumi/stacks/p/s.json'), {}, bodyOf('x').sha256);
      const noBody = await sendsNothing(routed(put), put);
      expect(noBody.refusal?.code).toBe('internal-error');
    });

    it('refuses a body whose digest is not the one the signature covered', async () => {
      const body = bodyOf('real');
      const put = request('PUT', objectUrl('.pulumi/stacks/p/s.json'), {}, bodyOf('other').sha256);
      const answer = await sendsNothing(routed(put), put, TENANT, body);
      expect(answer.refusal?.code).toBe('internal-error');
    });
  });

  it('is built only over a bare https origin, or http on loopback', () => {
    const base = {
      region: 'fsn1',
      bucket: BUCKET,
      credentials: new UpstreamCredentials(KEY_ID, SECRET),
      deadlineMs: 1000,
    };
    expect(() =>
      createStateUpstream({ ...base, endpoint: 'http://shard.example.invalid' })
    ).toThrow(RangeError);
    expect(() =>
      createStateUpstream({ ...base, endpoint: 'https://shard.example.invalid/x' })
    ).toThrow(RangeError);
    expect(() => createStateUpstream({ ...base, endpoint: 'http://127.0.0.1:9000' })).not.toThrow();
    expect(() =>
      createStateUpstream({ ...base, endpoint: 'https://shard.example.invalid', deadlineMs: 0 })
    ).toThrow(RangeError);
  });
});
