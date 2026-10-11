import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { type AuthDeps, verifyRequest } from './auth.js';

/**
 * `POST /image` is the host side of the image-push design: pushed over the
 * same signed, inbound-only link `/reconcile` and `/reset` use, rather
 * than the host ever pulling from a registry. Every push stages at the
 * same fixed path, never a per-request random name, because the
 * sudoers-enumerated `load` verb is only authorisable against a literal.
 * See imagePush.md#post-image.
 */
export interface ImageLoader {
  /** Loads a tar previously verified against its declared digest. Never called on an unverified stream. */
  load(tarPath: string): Promise<{ readonly imageId: string }>;
}

export interface ImagePushDeps {
  readonly loader: ImageLoader;
  /** Where the pushed tar is spooled while its digest is checked -- never the loader's own working directory. */
  readonly tmpDir: string;
  /** Refuses a declared size above this before a single byte is read. */
  readonly maxBytes: number;
  readonly nowMs: () => number;
  readonly log: (line: string) => void;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SIZE_PATTERN = /^[0-9]{1,20}$/;
const IMAGE_PUSH_PATH = '/image';

/**
 * The literal filename `demo-host/provision/render_slot_sudoers.py`'s
 * `load` rule also carries -- kept as a separate literal on each side
 * deliberately (the same choice `config.ts`'s `slotLiterals` doc comment
 * makes against that generator's `SLOT_NAMES`): that file enumerates what
 * sudoers grants, this one enumerates what this handler ever writes to,
 * and nothing here reads that Python file at runtime.
 */
export const IMAGE_STAGING_FILENAME = 'image.tar';

/**
 * Keyed by `tmpDir` rather than a single module-level flag, so the many
 * independent broker instances a test process starts in sequence
 * (`startTestBroker()`, one fresh `tmpDir` per test) never see a stale
 * "in flight" left by an earlier, unrelated test.
 */
const pushInFlight = new Set<string>();

/**
 * The exact bytes a push's signature covers -- the declared digest and
 * size, never the image itself. Signing the whole body would force
 * buffering an arbitrarily large, still-unauthenticated stream before the
 * one check that actually authenticates the caller could run at all; this
 * keeps authentication O(1) in the size of the image, and both sides
 * (this file and `controlPlanePush.ts`) build the identical bytes from the
 * identical header values, never from a reformatted or reparsed copy.
 */
export function imagePushManifest(digest: string, size: string): Buffer {
  return Buffer.from(`${digest}\n${size}\n`, 'utf8');
}

function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['Content-Type'] = 'application/json';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function authHeaders(req: IncomingMessage): {
  timestamp?: string;
  nonce?: string;
  signature?: string;
} {
  return {
    timestamp: headerValue(req, 'x-broker-timestamp'),
    nonce: headerValue(req, 'x-broker-nonce'),
    signature: headerValue(req, 'x-broker-signature'),
  };
}

/**
 * Hashes and counts every chunk it passes through unchanged, and errors
 * the pipeline the instant more than `limitBytes` has arrived -- before
 * the over-limit chunk is ever written to disk, so an oversized push is
 * refused mid-stream rather than after spooling the whole thing.
 */
function hashingLimiter(limitBytes: number, hash: ReturnType<typeof createHash>): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limitBytes) {
        callback(new Error(`stream exceeded its ${limitBytes}-byte limit`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

/** What `readImageHeaders` found: the declared digest and size, or the refusal to send. */
export type ImageHeaders =
  | {
      readonly ok: true;
      readonly digest: string;
      readonly size: string;
      readonly declaredBytes: number;
    }
  | { readonly ok: false; readonly status: 400 | 413; readonly body: { readonly error: string } };

export type ImageAuthResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** What `receiveImage` ends in: the status and JSON body to send, nothing written yet. */
export type ImageReceipt =
  | {
      readonly status: 200;
      readonly body: {
        readonly digest: string;
        readonly imageId: string;
        readonly bytes: number;
        readonly durationMs: number;
      };
    }
  | { readonly status: 400 | 413 | 502; readonly body: { readonly error: string } }
  | {
      readonly status: 409;
      readonly body:
        | { readonly error: string }
        | { readonly error: string; readonly declared: string; readonly received: string };
    };

/**
 * The first refusals, in order: a malformed digest or size (400), then a
 * declared size over the host's limit (413) -- all before the signature is
 * looked at, and before a byte of the image is read.
 */
export function readImageHeaders(req: IncomingMessage, maxBytes: number): ImageHeaders {
  const digest = headerValue(req, 'x-image-digest');
  const size = headerValue(req, 'x-image-size');

  if (!digest || !DIGEST_PATTERN.test(digest)) {
    return {
      ok: false,
      status: 400,
      body: { error: 'x-image-digest must be "sha256:" followed by 64 lowercase hex characters' },
    };
  }
  if (!size || !SIZE_PATTERN.test(size)) {
    return { ok: false, status: 400, body: { error: 'x-image-size must be a decimal byte count' } };
  }
  const declaredBytes = Number(size);
  if (declaredBytes > maxBytes) {
    return {
      ok: false,
      status: 413,
      body: { error: `x-image-size exceeds the ${maxBytes}-byte limit` },
    };
  }
  return { ok: true, digest, size, declaredBytes };
}

/**
 * The signature check, over the manifest of the two header values just read.
 * Claims the request's nonce, so it must run once per request.
 */
export function authenticateImagePush(
  auth: AuthDeps,
  req: IncomingMessage,
  headers: { readonly digest: string; readonly size: string }
): ImageAuthResult {
  const result = verifyRequest(
    auth,
    req.method ?? '',
    IMAGE_PUSH_PATH,
    authHeaders(req),
    imagePushManifest(headers.digest, headers.size)
  );
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/**
 * Everything after authentication: single-flight, the streamed write, and
 * the digest check. **Load-bearing (this story's Done means): "a stream
 * whose digest does not match is refused"** -- `deps.loader.load` is called
 * on exactly one path below, and only after the freshly computed digest of
 * every byte received equals the digest the caller declared and signed for.
 */
export async function receiveImage(
  deps: ImagePushDeps,
  req: IncomingMessage,
  headers: { readonly digest: string; readonly declaredBytes: number }
): Promise<ImageReceipt> {
  const startedMs = deps.nowMs();
  const { digest, declaredBytes } = headers;

  // The fixed staging path is a shared resource across the whole host, not
  // per-request the way a `mkdtemp` name would be -- refuse a second push
  // outright rather than let two concurrent uploads race onto the same
  // file.
  if (pushInFlight.has(deps.tmpDir)) {
    req.resume();
    return {
      status: 409,
      body: { error: 'another image push is already in progress on this host' },
    };
  }
  pushInFlight.add(deps.tmpDir);

  try {
    const tarPath = join(deps.tmpDir, IMAGE_STAGING_FILENAME);
    const hash = createHash('sha256');
    let received = 0;
    const limiter = hashingLimiter(declaredBytes, hash);
    limiter.on('data', (chunk: Buffer) => {
      received += chunk.length;
    });

    try {
      await pipeline(req, limiter, createWriteStream(tarPath));
    } catch (err) {
      await rm(tarPath, { force: true });
      deps.log(`image push stream failed: ${(err as Error).message}`);
      return { status: 413, body: { error: (err as Error).message } };
    }

    if (received !== declaredBytes) {
      await rm(tarPath, { force: true });
      return {
        status: 400,
        body: { error: `received ${received} bytes but x-image-size declared ${declaredBytes}` },
      };
    }

    const computedDigest = `sha256:${hash.digest('hex')}`;
    if (computedDigest !== digest) {
      await rm(tarPath, { force: true });
      deps.log(`image push refused: declared ${digest}, received ${computedDigest}`);
      return {
        status: 409,
        body: {
          error: 'received bytes do not match the declared digest',
          declared: digest,
          received: computedDigest,
        },
      };
    }

    try {
      const { imageId } = await deps.loader.load(tarPath);
      // Cleaned up before the answer goes out, not in a `finally` after --
      // the client can see the response the instant it is written, and
      // that race is not one this test (or a caller polling the temp dir
      // right after) should ever have to account for.
      await rm(tarPath, { force: true });
      // Never negative: the adapter checks this body against the spec's
      // integer-at-least-zero, and a clock stepped back during the load must
      // not turn a loaded image into a 500.
      const durationMs = Math.max(0, deps.nowMs() - startedMs);
      return { status: 200, body: { digest, imageId, bytes: received, durationMs } };
    } catch (err) {
      await rm(tarPath, { force: true }).catch(() => undefined);
      deps.log(`image load failed: ${(err as Error).message}`);
      return { status: 502, body: { error: 'image failed to load' } };
    }
  } finally {
    pushInFlight.delete(deps.tmpDir);
  }
}

/**
 * Refuses before the loader is ever reached: a malformed header, a failed
 * signature, an oversized stream, a short/long delivery, or a digest that
 * does not match what arrived. This is the whole of a push as one call that
 * writes its own response; the broker itself reaches the same three steps
 * (`readImageHeaders`, `authenticateImagePush`, `receiveImage`) through the
 * generated adapter instead, and the live-proof receiver
 * (`test/live/fixtures/hostReceiver.mjs`) calls this one directly.
 */
export async function handleImagePush(
  auth: AuthDeps,
  deps: ImagePushDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const headers = readImageHeaders(req, deps.maxBytes);
  if (!headers.ok) {
    req.resume();
    sendJson(res, headers.status, headers.body);
    return;
  }
  const authResult = authenticateImagePush(auth, req, headers);
  if (!authResult.ok) {
    req.resume();
    deps.log(`refused POST ${IMAGE_PUSH_PATH}: ${authResult.reason}`);
    sendJson(res, 401, { error: authResult.reason });
    return;
  }
  const receipt = await receiveImage(deps, req, headers);
  sendJson(res, receipt.status, receipt.body);
}
