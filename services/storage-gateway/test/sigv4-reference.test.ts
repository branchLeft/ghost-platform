import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GatewayRequest } from '../src/contracts.js';
import {
  canonicalRequest,
  signatureHex,
  signingKey,
  stringToSign,
  splitTarget,
  SigV4Verifier,
} from '../src/sigv4-verifier.js';
import {
  buildQuery,
  referenceSign,
  sdkEscape,
  sha256Hex,
  type QueryValue,
  type SignSpec,
} from './support/reference-signer.js';
import { VECTOR_IDENTITY, VECTOR_SPECS } from './support/vector-specs.js';
import {
  IDENTITY,
  OTHER_KEY_ID,
  SIGNING_DATE,
  makeVerifier,
  withAuth,
  withHeaders,
  authOf,
} from './support/verifier-fixtures.js';

interface VectorFile {
  readonly signer: string;
  readonly identity: typeof VECTOR_IDENTITY;
  readonly vectors: readonly { readonly name: string; readonly request: GatewayRequest }[];
}

const VECTORS = JSON.parse(
  readFileSync(new URL('./fixtures/reference-vectors.json', import.meta.url), 'utf8')
) as VectorFile;

const verifier = makeVerifier();

async function reasonFor(request: GatewayRequest, v: SigV4Verifier = verifier): Promise<string> {
  const r = await v.verifyDetailed(request);
  return r.ok ? 'accepted' : r.reason;
}

function flipHex(hex: string): string {
  const last = hex.at(-1) === '0' ? '1' : '0';
  return hex.slice(0, -1) + last;
}

describe('checked-in reference vectors', () => {
  it('were produced by the pinned reference signer and still match it byte for byte', async () => {
    expect(VECTORS.signer).toBe('@smithy/signature-v4@5.6.1');
    expect(VECTORS.vectors.map((v) => v.name)).toEqual(VECTOR_SPECS.map((v) => v.name));
    for (const [i, v] of VECTOR_SPECS.entries()) {
      const fresh = await referenceSign(
        v.spec,
        { ...VECTOR_IDENTITY, signingDate: new Date(VECTOR_IDENTITY.signingDate) },
        v.rawQuery
      );
      expect(fresh.request, v.name).toEqual(VECTORS.vectors[i]?.request);
    }
  });

  it('include every Ghost request shape with its x-id and CRC32 checksum headers', () => {
    const ghost = VECTORS.vectors.filter((v) => v.name.startsWith('ghost '));
    expect(ghost.length).toBe(9);
    for (const v of ghost) expect(v.request.rawTarget, v.name).toMatch(/[?&]x-id=[A-Za-z]+/);
    for (const name of ['ghost PutObject', 'ghost UploadPart']) {
      const auth = authOf(VECTORS.vectors.find((v) => v.name === name)?.request as GatewayRequest);
      expect(auth).toContain('x-amz-checksum-crc32');
      expect(auth).toContain('x-amz-sdk-checksum-algorithm');
    }
  });

  it.each(VECTORS.vectors.map((v) => [v.name, v.request] as const))(
    'accepts the correctly signed %s',
    async (_name, request) => {
      expect(await verifier.verify(request)).toEqual({ ok: true, keyId: VECTOR_IDENTITY.keyId });
    }
  );

  describe.each(VECTORS.vectors.map((v) => [v.name, v.request] as const))(
    'refuses every altered copy of %s',
    (_name, request) => {
      const { path, query } = splitTarget(request.rawTarget);
      const auth = authOf(request);
      const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(';') ?? [];

      it('with another method', async () => {
        const method = request.method === 'GET' ? 'HEAD' : 'GET';
        expect(await reasonFor({ ...request, method })).toBe('signature-mismatch');
      });

      it('with a changed or extended object name', async () => {
        const changed = `${path.slice(0, -1)}${path.endsWith('g') ? 'G' : 'g'}`;
        const target = (p: string) => (query === '' ? p : `${p}?${query}`);
        expect(await reasonFor({ ...request, rawTarget: target(changed) })).toBe(
          'signature-mismatch'
        );
        expect(await reasonFor({ ...request, rawTarget: target(`${path}x`) })).toBe(
          'signature-mismatch'
        );
        expect(
          await reasonFor({
            ...request,
            rawTarget: target(path.replace(/^\/[^/]+/, '/other-bucket')),
          })
        ).toBe('signature-mismatch');
      });

      it('with an added, removed or changed query parameter', async () => {
        const base = query === '' ? path : `${path}?${query}`;
        const sep = query === '' ? '?' : '&';
        expect(await reasonFor({ ...request, rawTarget: `${base}${sep}extra=1` })).toBe(
          'signature-mismatch'
        );
        expect(await reasonFor({ ...request, rawTarget: path })).toBe('signature-mismatch');
        const changed = request.rawTarget.replace(/x-id=([A-Za-z]+)/, 'x-id=$1X');
        if (changed !== request.rawTarget) {
          expect(await reasonFor({ ...request, rawTarget: changed })).toBe('signature-mismatch');
        }
      });

      it('with any signed header value changed', async () => {
        for (const name of signed) {
          const value = request.headers[name];
          if (typeof value !== 'string') throw new Error(`missing ${name}`);
          const expected =
            name === 'x-amz-date'
              ? 'scope-mismatch'
              : name === 'x-amz-content-sha256'
                ? 'signature-mismatch'
                : 'signature-mismatch';
          const altered =
            name === 'x-amz-date'
              ? '20261007T093015Z'
              : name === 'x-amz-content-sha256'
                ? flipHex(value)
                : `${value}Z`;
          expect(await reasonFor(withHeaders(request, { [name]: altered })), name).toBe(expected);
        }
      });

      it('with the signature, key id or region altered', async () => {
        expect(await reasonFor(withAuth(request, flipHex(auth)))).toBe('signature-mismatch');
        expect(
          await reasonFor(withAuth(request, auth.replace(VECTOR_IDENTITY.keyId, OTHER_KEY_ID)))
        ).toBe('signature-mismatch');
        expect(await reasonFor(withAuth(request, auth.replace('KEY0001', 'KEY0009')))).toBe(
          'key-unknown'
        );
        expect(await reasonFor(withAuth(request, auth.replace('/nbg1/', '/fsn1/')))).toBe(
          'scope-mismatch'
        );
      });

      it('with a body other than the one signed', async () => {
        const tampered = { ...request, bodySha256: sha256Hex('TAMPERED_BODY') };
        expect(await reasonFor(tampered)).toBe('body-digest-mismatch');
      });

      it('with an x-amz header the signature does not cover', async () => {
        expect(await reasonFor(withHeaders(request, { 'x-amz-acl': 'public-read-write' }))).toBe(
          'amz-header-unsigned'
        );
      });

      it('but not when only an unsigned, non-x-amz header changes', async () => {
        expect(await reasonFor(withHeaders(request, { 'user-agent': 'something-else/1.0' }))).toBe(
          'accepted'
        );
      });
    }
  );
});

/** A small deterministic generator, so a failing differential case can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAME_CHARS = [
  ...'abcXYZ019-._~ +!$&\'()*,;=:@%[]{}^`|"<>\\#?',
  'é',
  'ß',
  '日',
  '\u{1f600}',
  '\u00a0',
];
const VALUE_CHARS = [...'abcXYZ019-._~ \t,;=:/"'];

describe('differential test against the live reference signer', () => {
  const rand = mulberry32(0x5194);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const word = (chars: readonly string[], max: number): string =>
    Array.from({ length: 1 + Math.floor(rand() * max) }, () => pick(chars)).join('');

  function randomSpec(): SignSpec {
    const method = pick(['GET', 'HEAD', 'PUT', 'POST', 'DELETE']);
    const segments = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => word(NAME_CHARS, 12));
    const query: Record<string, QueryValue> = {
      'x-id': pick(['GetObject', 'PutObject', 'UploadPart']),
    };
    for (let i = 0; i < Math.floor(rand() * 3); i += 1)
      query[word(NAME_CHARS, 6)] = word(NAME_CHARS, 10);
    const headers: Record<string, string> = { host: 'storage-gateway.internal:8443' };
    for (let i = 0; i < Math.floor(rand() * 3); i += 1) {
      headers[`x-amz-meta-${word([...'abcxyz019-'], 8)}`] = `${word(VALUE_CHARS, 20)}v`;
    }
    const body = method === 'PUT' || method === 'POST' ? word(NAME_CHARS, 40) : '';
    return {
      method,
      path: `/${segments.map(sdkEscape).join('/')}`,
      query,
      headers,
      body,
      payloadHash: sha256Hex(body),
    };
  }

  it('accepts all 300 randomly generated signed requests and refuses each one-character alteration', async () => {
    let refusedAlterations = 0;
    for (let i = 0; i < 300; i += 1) {
      const spec = randomSpec();
      const { request } = await referenceSign(spec, IDENTITY);
      expect(await reasonFor(request), JSON.stringify(spec)).toBe('accepted');

      const { path } = splitTarget(request.rawTarget);
      const at = 1 + Math.floor(rand() * (path.length - 1));
      const ch = path[at] === 'q' ? 'Q' : 'q';
      const altered = `${path.slice(0, at)}${ch}${path.slice(at + 1)}`;
      const query = buildQuery(spec.query ?? {});
      expect(
        await reasonFor({ ...request, rawTarget: `${altered}?${query}` }),
        JSON.stringify(spec)
      ).toBe('signature-mismatch');

      const qAltered = `${path}?${query.replace('x-id=', 'x-id=Q')}`;
      expect(await reasonFor({ ...request, rawTarget: qAltered })).toBe('signature-mismatch');

      const tampered = { ...request, bodySha256: sha256Hex(`${spec.body ?? ''}!`) };
      expect(await reasonFor(tampered)).toBe('body-digest-mismatch');
      refusedAlterations += 3;
    }
    expect(refusedAlterations).toBe(900);
  });
});

interface SuiteCase {
  readonly name: string;
  readonly context: {
    readonly credentials: { readonly access_key_id: string; readonly secret_access_key: string };
    readonly region: string;
    readonly service: string;
    readonly timestamp: string;
  };
  readonly signedRequest: string;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

const SUITE = JSON.parse(
  readFileSync(new URL('./fixtures/aws-sigv4-suite.json', import.meta.url), 'utf8')
) as { readonly cases: readonly SuiteCase[] };

/** Parses the suite's HTTP/1.1 text into the gateway's request model, folding continuation lines. */
function parseSuiteRequest(text: string): { request: GatewayRequest; body: string } {
  const [head = '', ...rest] = text.split('\n\n');
  const [requestLine = '', ...lines] = head.split('\n');
  const [method = '', target = ''] = requestLine.split(' ');
  const headers: Record<string, string[]> = {};
  let last: string[] | undefined;
  let lastIndex = 0;
  for (const line of lines) {
    if (/^\s/.test(line) && last !== undefined) {
      last[lastIndex] = `${last[lastIndex] ?? ''}\n${line}`;
      continue;
    }
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).toLowerCase();
    last = headers[name] ?? [];
    headers[name] = last;
    lastIndex = last.push(line.slice(colon + 1)) - 1;
  }
  const flat: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) flat[k] = v.length === 1 ? (v[0] as string) : v;
  const body = rest.join('\n\n');
  return {
    request: { method, rawTarget: target, headers: flat, bodySha256: sha256Hex(body) },
    body,
  };
}

describe('the official AWS SigV4 test suite', () => {
  it('carries the header-signed cases that apply to S3', () => {
    expect(SUITE.cases.length).toBe(23);
  });

  it.each(SUITE.cases.map((c) => [c.name, c] as const))(
    '%s: canonical request, string to sign and signature match',
    (_name, c) => {
      const { request, body } = parseSuiteRequest(c.signedRequest);
      const auth = authOf(request);
      const signedHeaders = (/SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? '').split(';');
      const headers = new Map<string, readonly string[]>();
      for (const [k, v] of Object.entries(request.headers)) {
        if (v !== undefined) headers.set(k, typeof v === 'string' ? [v] : v);
      }
      const { path, query } = splitTarget(request.rawTarget);
      const payloadHash =
        typeof request.headers['x-amz-content-sha256'] === 'string'
          ? request.headers['x-amz-content-sha256']
          : createHash('sha256').update(body).digest('hex');
      const creq = canonicalRequest({
        method: request.method,
        path,
        rawQuery: query,
        headers,
        signedHeaders,
        payloadHash,
      });
      expect(creq).toBe(c.canonicalRequest);

      const amzDate = request.headers['x-amz-date'] as string;
      const scope = `${amzDate.slice(0, 8)}/${c.context.region}/${c.context.service}/aws4_request`;
      const sts = stringToSign(amzDate, scope, creq);
      expect(sts).toBe(c.stringToSign);
      const key = signingKey(
        c.context.credentials.secret_access_key,
        amzDate.slice(0, 8),
        c.context.region,
        c.context.service
      );
      expect(signatureHex(key, sts)).toBe(c.signature);
    }
  );

  it.each(SUITE.cases.map((c) => [c.name, c] as const))(
    '%s: the full check accepts it only if it signs a payload hash and every x-amz header',
    async (_name, c) => {
      const { request } = parseSuiteRequest(c.signedRequest);
      const suiteVerifier = makeVerifier({
        region: c.context.region,
        service: c.context.service,
        secrets: {
          secretFor: (k) =>
            Promise.resolve(
              k === c.context.credentials.access_key_id
                ? c.context.credentials.secret_access_key
                : undefined
            ),
        },
        now: () => Date.parse(c.context.timestamp),
      });
      const auth = authOf(request);
      const expected = !auth.includes('x-amz-content-sha256')
        ? 'required-header-unsigned'
        : 'accepted';
      expect(await reasonFor(request, suiteVerifier)).toBe(expected);
    }
  );
});

describe('the reference signer and the gateway agree on the signing date', () => {
  it('uses the scope date of the signing instant', async () => {
    const { request } = await referenceSign(
      { method: 'GET', path: '/b/f/o', query: { 'x-id': 'GetObject' }, headers: { host: 'h' } },
      IDENTITY
    );
    expect(authOf(request)).toContain(
      `/${SIGNING_DATE.toISOString().slice(0, 10).replace(/-/g, '')}/`
    );
  });
});
