/**
 * The control-plane half of LLD-4 U9: dials into the host's already-open
 * inbound link (the same signed scheme `/reconcile` and `/reset` use) and
 * streams an image it already holds locally. Never reads a registry and
 * never touches a credential store of any kind — `tarPath` is assumed
 * already present on disk (this repo's own proof produces one with
 * `docker save <content digest>`, never by fetching it from anywhere),
 * because delivering it is this module's whole job, not producing it.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
// The generated client can neither stream nor sign: see app.md#generated-server.
import { pushImage as generatedPushImage } from './generated/index.js';

import { imagePushManifest } from './imagePush.js';
import { signRequest } from './signing.js';

export interface PushImageArgs {
  readonly baseUrl: string;
  /** `sha256:<64 lowercase hex>` — the digest of the tar's own bytes, checked by the receiver against what actually arrives. */
  readonly digest: string;
  readonly tarPath: string;
  readonly privateKeyRaw: Buffer;
  readonly nowSeconds?: number;
  readonly nonce?: string;
}

export interface PushImageResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

const IMAGE_PUSH_PATH = '/image';

export async function pushImage(args: PushImageArgs): Promise<PushImageResult> {
  const { size } = await stat(args.tarPath);
  const sizeStr = String(size);
  const timestamp = String(args.nowSeconds ?? Math.floor(Date.now() / 1000));
  const nonce = args.nonce ?? randomBytes(16).toString('hex');

  const manifest = imagePushManifest(args.digest, sizeStr);
  const signature = signRequest(
    args.privateKeyRaw,
    'POST',
    IMAGE_PUSH_PATH,
    timestamp,
    nonce,
    manifest
  );

  // A streamed request body, not a buffered one: this is the same "over
  // our own link, not from a CDN" cost LLD-4 U9 names, and it is measured
  // rather than hidden by reading the whole tar into memory first. The
  // generated client types the body as a string (and never serialises it:
  // the operation declares an octet-stream), so the stream goes in through
  // a cast, to the one place the type is wrong about what fetch accepts.
  const body = Readable.toWeb(
    createReadStream(args.tarPath)
  ) as unknown as globalThis.ReadableStream<Uint8Array>;

  const result = await generatedPushImage({
    baseUrl: args.baseUrl,
    // Node's fetch requires this for any request carrying a streamed body;
    // neither the client's options nor its own types know the option, hence
    // the cast rather than a `@ts-expect-error` this repo's CI TypeScript
    // version may or may not agree needs one.
    ...({ duplex: 'half' } as Record<string, unknown>),
    headers: {
      'X-Broker-Timestamp': timestamp,
      'X-Broker-Nonce': nonce,
      'X-Broker-Signature': signature,
      'X-Image-Digest': args.digest,
      'X-Image-Size': sizeStr,
      'Content-Length': sizeStr,
    },
    body: body as unknown as string,
  });
  // No response at all means the request itself failed (refused, reset):
  // rethrown, as a rejected `fetch` always was, rather than reported as a
  // status this module never received.
  if (result.response === undefined) throw result.error;
  const { ok, status } = result.response;
  // A non-2xx answer arrives as the parsed JSON, or the raw text when it was
  // not JSON; only the former was ever handed back.
  const responseBody: unknown = ok
    ? result.data
    : typeof result.error === 'object'
      ? result.error
      : undefined;
  return { ok, status, body: responseBody };
}
