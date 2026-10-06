import { describe, expect, it } from 'vitest';
import type { GatewayRequest } from '../src/contracts.js';
import {
  DEFAULT_CLOCK_WINDOW_MS,
  REQUIRED_SIGNED_HEADERS,
  SigV4Verifier,
  canonicalQuery,
} from '../src/sigv4-verifier.js';
import {
  referencePresign,
  referenceSign,
  sha256Hex,
  type SignSpec,
} from './support/reference-signer.js';
import {
  IDENTITY,
  KEY_ID,
  REGION,
  SIGNING_DATE,
  authOf,
  makeVerifier,
  secretTable,
  withAuth,
  withHeaders,
} from './support/verifier-fixtures.js';

const HOST = 'storage-gateway.internal:8443';
const BODY = 'IMAGE_BYTES_PLACEHOLDER';

const PUT: SignSpec = {
  method: 'PUT',
  path: '/media-shard-a/q7f3k2m9x1/photo.png',
  query: { 'x-id': 'PutObject' },
  headers: {
    host: HOST,
    'content-type': 'image/png',
    'content-length': String(BODY.length),
    'x-amz-checksum-crc32': 'NSRBwg==',
    'x-amz-sdk-checksum-algorithm': 'CRC32',
  },
  body: BODY,
  payloadHash: sha256Hex(BODY),
};

const GET: SignSpec = {
  method: 'GET',
  path: '/media-shard-a/q7f3k2m9x1/photo.png',
  query: { 'x-id': 'GetObject' },
  headers: { host: HOST },
};

const verifier = makeVerifier();

async function sign(spec: SignSpec = PUT): Promise<GatewayRequest> {
  return (await referenceSign(spec, IDENTITY)).request;
}

async function reasonFor(request: GatewayRequest, v: SigV4Verifier = verifier): Promise<string> {
  const r = await v.verifyDetailed(request);
  return r.ok ? 'accepted' : r.reason;
}

describe('a correctly signed request', () => {
  it('is accepted, naming the key id', async () => {
    expect(await verifier.verify(await sign())).toEqual({ ok: true, keyId: KEY_ID });
  });

  it('is refused through verify() in the contract shape, without the internal reason', async () => {
    const r = await verifier.verify(withHeaders(await sign(), { authorization: undefined }));
    expect(r).toEqual({
      ok: false,
      refusal: {
        code: 'signature-refused',
        message: 'The request signature was not accepted.',
        status: 403,
      },
    });
  });
});

describe('payload signing', () => {
  it('refuses UNSIGNED-PAYLOAD even when the signature over it is valid', async () => {
    const request = await sign({ ...PUT, payloadHash: 'UNSIGNED-PAYLOAD' });
    expect(authOf(request)).toContain('x-amz-content-sha256');
    expect(await verifier.verifyDetailed(request)).toMatchObject({
      ok: false,
      reason: 'payload-unsigned',
    });
  });

  it.each([
    'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
    'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
    'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
  ])('refuses the streaming payload mode %s', async (mode) => {
    expect(await reasonFor(await sign({ ...PUT, payloadHash: mode }))).toBe('payload-streaming');
  });

  it.each([
    ['content-encoding', 'aws-chunked'],
    ['content-encoding', 'gzip, AWS-CHUNKED'],
    ['x-amz-decoded-content-length', '23'],
    ['x-amz-trailer', 'x-amz-checksum-crc32'],
  ])('refuses a chunked upload signalled by %s: %s', async (name, value) => {
    const spec = { ...PUT, headers: { ...PUT.headers, [name]: value } };
    expect(await reasonFor(await sign(spec))).toBe('payload-streaming');
  });

  it.each(['', 'abc', sha256Hex(BODY).toUpperCase(), `${sha256Hex(BODY)}0`])(
    'refuses a payload hash that is not 64 lower-case hex digits: %j',
    async (hash) => {
      expect(await reasonFor(await sign({ ...PUT, payloadHash: hash }))).toBe(
        'payload-hash-malformed'
      );
    }
  );

  it('refuses a body whose digest differs from the signed payload hash', async () => {
    const request = { ...(await sign()), bodySha256: sha256Hex('A DIFFERENT BODY') };
    expect(await reasonFor(request)).toBe('body-digest-mismatch');
  });

  it('refuses a malformed body digest', async () => {
    const request = { ...(await sign()), bodySha256: sha256Hex(BODY).toUpperCase() };
    expect(await reasonFor(request)).toBe('body-digest-mismatch');
  });

  it.each(['PUT', 'POST', 'PATCH'])(
    'refuses a %s whose body digest the body stage never supplied',
    async (method) => {
      const { bodySha256: _, ...request } = await sign({ ...PUT, method });
      expect(await reasonFor(request)).toBe('body-digest-missing');
    }
  );

  it('treats a missing digest as an empty body for a bodiless method', async () => {
    const { bodySha256: _, ...request } = await sign(GET);
    expect(await reasonFor(request)).toBe('accepted');
  });

  it('refuses a bodiless method with no digest that signed a non-empty payload hash', async () => {
    const { bodySha256: _, ...request } = await sign({ ...GET, payloadHash: sha256Hex('x') });
    expect(await reasonFor(request)).toBe('body-digest-mismatch');
  });
});

describe('presigned and SigV2 requests', () => {
  it('refuses a presigned request from the reference signer', async () => {
    const request = await referencePresign(GET, IDENTITY);
    expect(request.rawTarget).toContain('X-Amz-Signature=');
    expect(await reasonFor(request)).toBe('presigned');
  });

  it('refuses a presigned query even alongside a valid header signature', async () => {
    const signed = await sign(GET);
    const presigned = await referencePresign(GET, IDENTITY);
    const query = presigned.rawTarget.slice(presigned.rawTarget.indexOf('?'));
    expect(await reasonFor({ ...signed, rawTarget: `${GET.path}${query}` })).toBe('presigned');
  });

  it.each(['X-Amz-Algorithm', 'x-amz-credential', 'X-AMZ-SIGNATURE', 'X-Amz-SignedHeaders'])(
    'refuses a query carrying %s, whatever its case',
    async (name) => {
      const signed = await sign(GET);
      expect(await reasonFor({ ...signed, rawTarget: `${signed.rawTarget}&${name}=x` })).toBe(
        'presigned'
      );
    }
  );

  it('refuses a SigV2 Authorization header', async () => {
    const signed = await sign(GET);
    expect(await reasonFor(withAuth(signed, `AWS ${KEY_ID}:c2lnbmF0dXJl`))).toBe('sigv2');
  });

  it.each(['AWSAccessKeyId', 'Signature'])('refuses a SigV2 query carrying %s', async (name) => {
    const signed = await sign(GET);
    expect(await reasonFor({ ...signed, rawTarget: `${signed.rawTarget}&${name}=x` })).toBe(
      'sigv2'
    );
  });

  it('refuses SigV4a and any other algorithm', async () => {
    const signed = await sign(GET);
    const auth = authOf(signed);
    expect(
      await reasonFor(withAuth(signed, auth.replace('AWS4-HMAC-SHA256', 'AWS4-ECDSA-P256-SHA256')))
    ).toBe('algorithm-unsupported');
    expect(await reasonFor(withAuth(signed, 'Bearer abc'))).toBe('algorithm-unsupported');
  });
});

describe('the Authorization header', () => {
  it('must be present', async () => {
    expect(await reasonFor(withHeaders(await sign(GET), { authorization: undefined }))).toBe(
      'authorization-missing'
    );
  });

  it('must arrive once', async () => {
    const signed = await sign(GET);
    const auth = authOf(signed);
    expect(await reasonFor(withHeaders(signed, { authorization: [auth, auth] }))).toBe(
      'authorization-repeated'
    );
  });

  it('is accepted with an array of one value', async () => {
    const signed = await sign(GET);
    expect(await reasonFor(withHeaders(signed, { authorization: [authOf(signed)] }))).toBe(
      'accepted'
    );
  });

  it.each([
    ['no signature', (a: string) => a.replace(/, Signature=.*/, '')],
    [
      'an upper-case signature',
      (a: string) =>
        a.replace(/Signature=(\w+)/, (_m, s: string) => `Signature=${s.toUpperCase()}`),
    ],
    ['a short signature', (a: string) => a.slice(0, -1)],
    ['a trailing field', (a: string) => `${a}, Extra=1`],
    ['a four-part scope', (a: string) => a.replace('/aws4_request', '')],
    ['a six-part scope', (a: string) => a.replace('/aws4_request', '/aws4_request/x')],
    ['an empty key id', (a: string) => a.replace(KEY_ID, '')],
    ['a key id with a space', (a: string) => a.replace(KEY_ID, 'KEY%20ID')],
    [
      'fields out of order',
      (a: string) =>
        a.replace(/Credential=(\S+), SignedHeaders=(\S+),/, 'SignedHeaders=$2, Credential=$1,'),
    ],
  ])('is refused with %s', async (_label, mutate) => {
    const signed = await sign(GET);
    expect(await reasonFor(withAuth(signed, mutate(authOf(signed))))).toBe(
      'authorization-malformed'
    );
  });

  it('is accepted without the space after each comma', async () => {
    const signed = await sign(GET);
    expect(await reasonFor(withAuth(signed, authOf(signed).replace(/, /g, ',')))).toBe('accepted');
  });
});

describe('the credential scope', () => {
  it('must name the configured region', async () => {
    const request = (await referenceSign(GET, { ...IDENTITY, region: 'fsn1' })).request;
    expect(await reasonFor(request)).toBe('scope-mismatch');
  });

  it('must name the s3 service', async () => {
    const request = (await referenceSign(GET, { ...IDENTITY, service: 'sts' })).request;
    expect(await reasonFor(request)).toBe('scope-mismatch');
  });

  it('accepts another configured service and region', async () => {
    const request = (await referenceSign(GET, { ...IDENTITY, region: 'fsn1', service: 'x' }))
      .request;
    const v = makeVerifier({ region: 'fsn1', service: 'x' });
    expect(await reasonFor(request, v)).toBe('accepted');
  });

  it('must carry the same date as x-amz-date', async () => {
    const signed = await sign(GET);
    const auth = authOf(signed).replace('/20261006/', '/20261005/');
    expect(await reasonFor(withAuth(signed, auth))).toBe('scope-mismatch');
  });

  it('must end in aws4_request', async () => {
    const signed = await sign(GET);
    const auth = authOf(signed).replace('/aws4_request', '/aws5_request');
    expect(await reasonFor(withAuth(signed, auth))).toBe('scope-mismatch');
  });
});

describe('signed headers', () => {
  it.each(REQUIRED_SIGNED_HEADERS)(
    'refuses a validly signed request that leaves %s unsigned',
    async (name) => {
      const request = (
        await referenceSign(PUT, IDENTITY, undefined, { unsignableHeaders: new Set([name]) })
      ).request;
      expect(authOf(request)).not.toMatch(new RegExp(`[=;]${name}[;,]`));
      expect(await reasonFor(request)).toBe('required-header-unsigned');
    }
  );

  it('accepts a request that leaves a non-x-amz header unsigned', async () => {
    const request = (
      await referenceSign(PUT, IDENTITY, undefined, {
        unsignableHeaders: new Set(['content-type']),
      })
    ).request;
    expect(await reasonFor(request)).toBe('accepted');
  });

  it('refuses an x-amz header left out of the signature', async () => {
    const request = (
      await referenceSign(PUT, IDENTITY, undefined, {
        unsignableHeaders: new Set(['x-amz-checksum-crc32']),
      })
    ).request;
    expect(await reasonFor(request)).toBe('amz-header-unsigned');
  });

  it.each([
    [
      'unsorted',
      (s: string) => s.replace('content-length;content-type', 'content-type;content-length'),
    ],
    ['upper-case', (s: string) => s.replace('host', 'Host')],
    ['repeated', (s: string) => s.replace('host;', 'host;host;')],
    ['empty entry', (s: string) => s.replace('host;', 'host;;')],
    [
      'including authorization',
      (s: string) =>
        s
          .replace('amz-sdk', 'authorization;amz-sdk')
          .replace('SignedHeaders=content', 'SignedHeaders=authorization;content'),
    ],
  ])('refuses a signed-headers list that is %s', async (_label, mutate) => {
    const signed = await sign();
    const auth = authOf(signed).replace(/SignedHeaders=[^,]+/, (m) => mutate(m));
    expect(auth).not.toBe(authOf(signed));
    expect(await reasonFor(withAuth(signed, auth))).toBe('signed-headers-malformed');
  });

  it('refuses a signed header that did not arrive', async () => {
    const signed = await sign();
    expect(await reasonFor(withHeaders(signed, { 'content-type': undefined }))).toBe(
      'signed-header-absent'
    );
  });

  it.each([
    ['x-amz-date', 'date-malformed'],
    ['x-amz-content-sha256', 'signed-header-absent'],
    ['host', 'signed-header-absent'],
  ])('refuses a request whose signed %s did not arrive', async (name, reason) => {
    expect(await reasonFor(withHeaders(await sign(), { [name]: undefined }))).toBe(reason);
  });

  it.each(['host', 'x-amz-date', 'x-amz-content-sha256'])(
    'refuses a repeated %s rather than choosing one',
    async (name) => {
      const signed = await sign();
      const value = signed.headers[name] as string;
      expect(await reasonFor(withHeaders(signed, { [name]: [value, value] }))).toBe(
        'header-repeated'
      );
    }
  );

  it('joins a repeated signed header the SigV4 way, in arrival order', async () => {
    const spec = { ...PUT, headers: { ...PUT.headers, 'x-amz-meta-tag': 'one,two' } };
    const signed = await sign(spec);
    expect(await reasonFor(withHeaders(signed, { 'x-amz-meta-tag': ['one', 'two'] }))).toBe(
      'accepted'
    );
    expect(await reasonFor(withHeaders(signed, { 'x-amz-meta-tag': [' one ', 'two '] }))).toBe(
      'accepted'
    );
    expect(await reasonFor(withHeaders(signed, { 'x-amz-meta-tag': ['two', 'one'] }))).toBe(
      'signature-mismatch'
    );
  });

  it('ignores an empty header array and reads names case-insensitively', async () => {
    const signed = await sign(GET);
    const { host, ...rest } = signed.headers;
    const request = { ...signed, headers: { ...rest, Host: host, 'x-empty': [] } };
    expect(await reasonFor(request)).toBe('accepted');
  });
});

describe('the clock window', () => {
  it(`defaults to five minutes`, () => {
    expect(DEFAULT_CLOCK_WINDOW_MS).toBe(300_000);
  });

  const at = (offset: number, window?: number) =>
    makeVerifier({
      now: () => SIGNING_DATE.getTime() + offset,
      ...(window === undefined ? {} : { clockWindowMs: window }),
    });

  it.each([
    ['exactly the window late', DEFAULT_CLOCK_WINDOW_MS, 'accepted'],
    ['exactly the window early', -DEFAULT_CLOCK_WINDOW_MS, 'accepted'],
    ['one millisecond past the window: stale', DEFAULT_CLOCK_WINDOW_MS + 1, 'clock-skew'],
    ['one millisecond before the window: future-dated', -DEFAULT_CLOCK_WINDOW_MS - 1, 'clock-skew'],
    ['a day stale', 86_400_000, 'clock-skew'],
    ['a day in the future', -86_400_000, 'clock-skew'],
  ])('a request %s is %s', async (_label, offset, expected) => {
    expect(await reasonFor(await sign(), at(offset))).toBe(expected);
  });

  it('honours a configured window', async () => {
    expect(await reasonFor(await sign(), at(60_001, 60_000))).toBe('clock-skew');
    expect(await reasonFor(await sign(), at(60_000, 60_000))).toBe('accepted');
  });

  it('uses the real clock by default, so an old request is stale', async () => {
    const v = new SigV4Verifier({ region: REGION, secrets: secretTable() });
    const old = (
      await referenceSign(GET, { ...IDENTITY, signingDate: new Date('2020-01-01T00:00:00Z') })
    ).request;
    expect(await reasonFor(old, v)).toBe('clock-skew');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a clock window of %s at construction',
    (w) => {
      expect(() => makeVerifier({ clockWindowMs: w })).toThrow(RangeError);
    }
  );

  it.each([
    '20261006T093015',
    '2026-10-06T09:30:15Z',
    '20261306T093015Z',
    '20260231T093015Z',
    '20261006T246015Z',
    ' 20261006T093015Z',
  ])('refuses the malformed x-amz-date %j', async (value) => {
    expect(await reasonFor(withHeaders(await sign(), { 'x-amz-date': value }))).toBe(
      'date-malformed'
    );
  });
});

describe('the request target', () => {
  it.each(['photo.png', '', '*'])('refuses a target not starting with a slash: %j', async (t) => {
    expect(await reasonFor({ ...(await sign(GET)), rawTarget: t })).toBe('target-malformed');
  });

  it.each(['%zz=1', 'a=%E0%A4%A', 'x-id=GetObject&&a=1', '&x-id=GetObject'])(
    'refuses an undecodable or empty query piece: %j',
    async (q) => {
      expect(await reasonFor({ ...(await sign(GET)), rawTarget: `${GET.path}?${q}` })).toBe(
        'target-malformed'
      );
    }
  );

  it('treats a bare trailing ? as an empty query', async () => {
    const spec = { ...GET, query: {} };
    const signed = await sign(spec);
    expect(await reasonFor({ ...signed, rawTarget: `${GET.path}?` })).toBe('accepted');
  });

  it('canonicalises a query by encoded name, then value', () => {
    expect(canonicalQuery('b=2&a=z&a=y&%7b=t&~=u&c')).toBe('%7B=t&a=y&a=z&b=2&c=&~=u');
    expect(canonicalQuery('')).toBe('');
  });
});

describe('the tenant secret', () => {
  it('refuses a key id the source never issued', async () => {
    const v = makeVerifier({ secrets: secretTable({}) });
    expect(await reasonFor(await sign(), v)).toBe('key-unknown');
  });

  it('refuses when the source answers with an empty secret', async () => {
    const v = makeVerifier({ secrets: secretTable({ [KEY_ID]: '' }) });
    expect(await reasonFor(await sign(), v)).toBe('key-unknown');
  });

  it('refuses a signature made with another tenant secret', async () => {
    const v = makeVerifier({ secrets: secretTable({ [KEY_ID]: 'NOT_THE_SECRET' }) });
    expect(await reasonFor(await sign(), v)).toBe('signature-mismatch');
  });

  it('fails closed with an internal error when the source rejects', async () => {
    const v = makeVerifier({
      secrets: { secretFor: () => Promise.reject(new Error('derivation unavailable')) },
    });
    expect(await v.verifyDetailed(await sign())).toEqual({
      ok: false,
      reason: 'internal-failure',
      refusal: {
        code: 'internal-error',
        message: 'The gateway could not decide this request. Try again.',
        status: 503,
      },
    });
  });

  it('does not ask the source for a request refused on its shape', async () => {
    let asked = 0;
    const v = makeVerifier({
      secrets: {
        secretFor: () => {
          asked += 1;
          return Promise.resolve(undefined);
        },
      },
    });
    await v.verify(await sign({ ...PUT, payloadHash: 'UNSIGNED-PAYLOAD' }));
    await v.verify(await referencePresign(GET, IDENTITY));
    expect(asked).toBe(0);
  });
});
