import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { type AuthDeps, verifyRequest } from './auth.js';

/**
 * `POST /image` is the host side of LLD-4 U9: the control plane pushes
 * each new image over the connection it already dials into this host with
 * -- the same signed, inbound-only link `/reconcile` and `/reset` use --
 * rather than the host ever pulling from a registry. This module is the
 * one place that receives a pushed image and decides whether to trust it;
 * `plugins/dockerImageLoader.ts` is the one place that then loads it, and
 * is the only file in this service that shells out to `docker` at all --
 * an audit for "does anything here ever `pull`" has exactly one file to
 * read, and it is not this one.
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

/**
 * Refuses before the loader is ever reached: a malformed header, a failed
 * signature, an oversized stream, a short/long delivery, or a digest that
 * does not match what arrived. **Load-bearing (this story's Done means):
 * "a stream whose digest does not match is refused"** -- `deps.loader.load`
 * is called on exactly one path below, and only after the freshly computed
 * digest of every byte received equals the digest the caller declared and
 * signed for.
 */
export async function handleImagePush(
  auth: AuthDeps,
  deps: ImagePushDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const startedMs = deps.nowMs();
  const digest = headerValue(req, 'x-image-digest');
  const size = headerValue(req, 'x-image-size');

  if (!digest || !DIGEST_PATTERN.test(digest)) {
    req.resume();
    sendJson(res, 400, {
      error: 'x-image-digest must be "sha256:" followed by 64 lowercase hex characters',
    });
    return;
  }
  if (!size || !SIZE_PATTERN.test(size)) {
    req.resume();
    sendJson(res, 400, { error: 'x-image-size must be a decimal byte count' });
    return;
  }
  const declaredBytes = Number(size);
  if (declaredBytes > deps.maxBytes) {
    req.resume();
    sendJson(res, 413, { error: `x-image-size exceeds the ${deps.maxBytes}-byte limit` });
    return;
  }

  const manifest = imagePushManifest(digest, size);
  const authResult = verifyRequest(
    auth,
    req.method ?? '',
    IMAGE_PUSH_PATH,
    authHeaders(req),
    manifest
  );
  if (!authResult.ok) {
    req.resume();
    deps.log(`refused POST ${IMAGE_PUSH_PATH}: ${authResult.reason}`);
    sendJson(res, 401, { error: authResult.reason });
    return;
  }

  const dir = await mkdtemp(join(deps.tmpDir, 'image-push-'));
  const tarPath = join(dir, 'image.tar');
  const hash = createHash('sha256');
  let received = 0;
  const limiter = hashingLimiter(declaredBytes, hash);
  limiter.on('data', (chunk: Buffer) => {
    received += chunk.length;
  });

  try {
    await pipeline(req, limiter, createWriteStream(tarPath));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    deps.log(`image push stream failed: ${(err as Error).message}`);
    sendJson(res, 413, { error: (err as Error).message });
    return;
  }

  if (received !== declaredBytes) {
    await rm(dir, { recursive: true, force: true });
    sendJson(res, 400, {
      error: `received ${received} bytes but x-image-size declared ${declaredBytes}`,
    });
    return;
  }

  const computedDigest = `sha256:${hash.digest('hex')}`;
  if (computedDigest !== digest) {
    await rm(dir, { recursive: true, force: true });
    deps.log(`image push refused: declared ${digest}, received ${computedDigest}`);
    sendJson(res, 409, {
      error: 'received bytes do not match the declared digest',
      declared: digest,
      received: computedDigest,
    });
    return;
  }

  try {
    const { imageId } = await deps.loader.load(tarPath);
    // Cleaned up before responding, not in a `finally` after -- the client
    // can see this response the instant `sendJson` calls `res.end()`, and
    // that race is not one this test (or a caller polling the temp dir
    // right after) should ever have to account for.
    await rm(dir, { recursive: true, force: true });
    const durationMs = deps.nowMs() - startedMs;
    sendJson(res, 200, { digest, imageId, bytes: received, durationMs });
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    deps.log(`image load failed: ${(err as Error).message}`);
    sendJson(res, 502, { error: 'image failed to load' });
  }
}
