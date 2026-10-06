import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import type { GatewayRequest } from '../../src/contracts.js';

/** The `@smithy/signature-v4` hash interface, backed by node:crypto. */
class NodeSha256 {
  private readonly hash: Hash | Hmac;

  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash =
      secret === undefined
        ? createHash('sha256')
        : createHmac(
            'sha256',
            typeof secret === 'string'
              ? secret
              : Buffer.from(ArrayBuffer.isView(secret) ? secret.buffer : secret)
          );
  }

  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(
      typeof data === 'string'
        ? data
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : Buffer.from(data)
    );
  }

  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()));
  }

  reset(): void {
    throw new Error('not needed by the signer');
  }
}

export type QueryValue = string | readonly string[];

/** One request to sign, described the way the S3 client describes it before sending. */
export interface SignSpec {
  readonly method: string;
  /** The path as the SDK puts it on the wire: already percent-encoded. */
  readonly path: string;
  /** Decoded query parameters; the signer and the wire encoding each encode them. */
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** Headers set before signing, with lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Omit to let the signer compute the payload hash itself. */
  readonly payloadHash?: string;
}

export interface SignerIdentity {
  readonly keyId: string;
  readonly secret: string;
  readonly region: string;
  readonly service?: string;
  readonly signingDate: Date;
}

/** RFC 3986 encoding the way the SDK's query-string builder writes it. */
export function sdkEscape(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Builds the wire query in insertion order, one `name=value` per value. */
export function buildQuery(
  query: Readonly<Record<string, QueryValue>>,
  escape: (v: string) => string = sdkEscape
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    for (const one of typeof v === 'string' ? [v] : v) parts.push(`${escape(k)}=${escape(one)}`);
  }
  return parts.join('&');
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export interface SignedRequest {
  readonly request: GatewayRequest;
  /** The headers the reference signer produced, for building tampered copies. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Signs with the reference signer exactly as the S3 client configures it
 * (`uriEscapePath: false`: S3 signs the path as sent) and returns the request
 * as the gateway would receive it. `rawQuery` overrides the wire query, to
 * test an equivalent but differently encoded form.
 */
export async function referenceSign(
  spec: SignSpec,
  identity: SignerIdentity,
  rawQuery?: string,
  options: { readonly unsignableHeaders?: Set<string> } = {}
): Promise<SignedRequest> {
  const signer = makeSigner(identity);
  const body = spec.body ?? '';
  const headers: Record<string, string> = { ...spec.headers };
  if (spec.payloadHash !== undefined) headers['x-amz-content-sha256'] = spec.payloadHash;
  const signed = await signer.sign(toSmithy(spec, headers), {
    signingDate: identity.signingDate,
    ...(options.unsignableHeaders === undefined
      ? {}
      : { unsignableHeaders: options.unsignableHeaders }),
  });
  const query = rawQuery ?? buildQuery(spec.query ?? {});
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(signed.headers)) out[k.toLowerCase()] = v;
  return {
    headers: out,
    request: {
      method: spec.method,
      rawTarget: query === '' ? spec.path : `${spec.path}?${query}`,
      headers: out,
      bodySha256: sha256Hex(body),
    },
  };
}

/** A presigned (query-authenticated) request from the reference signer. */
export async function referencePresign(
  spec: SignSpec,
  identity: SignerIdentity
): Promise<GatewayRequest> {
  const signer = makeSigner(identity);
  const headers: Record<string, string> = { ...spec.headers };
  const presigned = await signer.presign(toSmithy(spec, headers), {
    signingDate: identity.signingDate,
    expiresIn: 300,
  });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(presigned.headers)) out[k.toLowerCase()] = v;
  const query = buildQuery(presigned.query as Record<string, QueryValue>);
  return {
    method: spec.method,
    rawTarget: `${spec.path}?${query}`,
    headers: out,
    bodySha256: sha256Hex(spec.body ?? ''),
  };
}

function toSmithy(spec: SignSpec, headers: Record<string, string>) {
  return {
    method: spec.method,
    protocol: 'https:',
    hostname: headers.host ?? 'gateway.invalid',
    path: spec.path,
    query: { ...(spec.query ?? {}) } as Record<string, string | string[]>,
    headers,
    body: spec.body ?? '',
  };
}

function makeSigner(identity: SignerIdentity): SignatureV4 {
  return new SignatureV4({
    credentials: { accessKeyId: identity.keyId, secretAccessKey: identity.secret },
    region: identity.region,
    service: identity.service ?? 's3',
    sha256: NodeSha256,
    uriEscapePath: false,
    applyChecksum: true,
  });
}
