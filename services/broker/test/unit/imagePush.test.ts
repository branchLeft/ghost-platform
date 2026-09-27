import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, '..', '..', 'src');

function digestOf(buf: Buffer): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

describe('POST /image (push delivery, no registry access)', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it('GREEN: a stream whose digest matches is loaded, and its temp file is cleaned up', async () => {
    broker = await startTestBroker();
    const bytes = Buffer.from('a small tar stand-in, digest is all that matters here');
    const digest = digestOf(bytes);
    const size = String(bytes.length);
    const headers = broker.signImagePushHeaders(digest, size);

    const res = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: {
        ...headers,
        'X-Image-Digest': digest,
        'X-Image-Size': size,
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      digest: string;
      imageId: string;
      bytes: number;
      durationMs: number;
    };
    expect(body.digest).toBe(digest);
    expect(body.bytes).toBe(bytes.length);
    expect(typeof body.durationMs).toBe('number');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);

    // The loader is the one thing "runs it by digest" depends on -- called
    // exactly once, with a path to a file that no longer exists once this
    // handler has answered (never left behind for the next push to trip
    // over, and never the loader's job to clean up its own input).
    expect(broker.imageLoader.calls).toHaveLength(1);
    expect(readdirSync(broker.imageTmpDir)).toEqual([]);
  });

  it('RED (the control this story exists for): a stream whose digest does not match is refused, and the loader is never called', async () => {
    broker = await startTestBroker();
    const bytes = Buffer.from('bytes that will not match the digest declared below');
    const wrongDigest = `sha256:${'0'.repeat(64)}`;
    const size = String(bytes.length);
    const headers = broker.signImagePushHeaders(wrongDigest, size);

    const res = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: { ...headers, 'X-Image-Digest': wrongDigest, 'X-Image-Size': size },
      body: bytes,
    });

    expect(res.status).toBe(409);
    expect(broker.imageLoader.calls).toHaveLength(0);
    expect(readdirSync(broker.imageTmpDir)).toEqual([]);
  });

  it('refuses a malformed x-image-digest before authentication is even checked', async () => {
    broker = await startTestBroker();
    const res = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      // No signed headers at all -- a shape refusal must not depend on them.
      headers: { 'X-Image-Digest': 'sha1:not-even-the-right-algorithm', 'X-Image-Size': '10' },
      body: Buffer.from('irrelevant'),
    });
    expect(res.status).toBe(400);
    expect(broker.imageLoader.calls).toHaveLength(0);
  });

  it('refuses a declared size that disagrees with what actually arrived (undersized delivery)', async () => {
    broker = await startTestBroker();
    const bytes = Buffer.from('the real body');
    const digest = digestOf(bytes);
    // Declares more than it sends -- the stream ends before the declared
    // count, so this exercises the post-stream length check rather than
    // the mid-stream limiter.
    const declaredSize = String(bytes.length + 5);
    const headers = broker.signImagePushHeaders(digest, declaredSize);

    const res = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: { ...headers, 'X-Image-Digest': digest, 'X-Image-Size': declaredSize },
      body: bytes,
    });

    expect(res.status).toBe(400);
    expect(broker.imageLoader.calls).toHaveLength(0);
    expect(readdirSync(broker.imageTmpDir)).toEqual([]);
  });

  it('refuses a stream that exceeds its own declared size mid-transfer, before writing the overflow to disk', async () => {
    broker = await startTestBroker();
    const bytes = Buffer.from(
      'this body is longer than what will be declared for it, deliberately'
    );
    const digest = digestOf(bytes);
    const declaredSize = String(bytes.length - 10);
    const headers = broker.signImagePushHeaders(digest, declaredSize);

    const res = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: { ...headers, 'X-Image-Digest': digest, 'X-Image-Size': declaredSize },
      body: bytes,
    });

    expect(res.status).toBe(413);
    expect(broker.imageLoader.calls).toHaveLength(0);
  });

  it('refuses an unauthenticated push before a single byte is written to disk', async () => {
    broker = await startTestBroker();
    const bytes = Buffer.from('an attacker with no key, sending a large-looking body');
    const digest = digestOf(bytes);
    const size = String(bytes.length);

    const res = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: {
        'X-Image-Digest': digest,
        'X-Image-Size': size,
        'X-Broker-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-Broker-Nonce': 'a'.repeat(16),
        'X-Broker-Signature': Buffer.alloc(64).toString('base64'), // well-formed, not valid
      },
      body: bytes,
    });

    expect(res.status).toBe(401);
    expect(broker.imageLoader.calls).toHaveLength(0);
    expect(readdirSync(broker.imageTmpDir)).toEqual([]);
  });

  it('refuses a replayed push -- the exact same signed headers, sent twice', async () => {
    const b = await startTestBroker();
    broker = b;
    const bytes = Buffer.from('replay me if you can');
    const digest = digestOf(bytes);
    const size = String(bytes.length);
    const headers = b.signImagePushHeaders(digest, size);
    const send = () =>
      fetch(`${b.baseUrl}/image`, {
        method: 'POST',
        headers: { ...headers, 'X-Image-Digest': digest, 'X-Image-Size': size },
        body: bytes,
      });

    const first = await send();
    expect(first.status).toBe(200);
    const second = await send();
    expect(second.status).toBe(401);
    // Only the first delivery ever reached the loader.
    expect(broker.imageLoader.calls).toHaveLength(1);
  });

  it('refuses a declared size above the configured limit, before authentication or any read', async () => {
    broker = await startTestBroker();
    const res = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: {
        'X-Image-Digest': `sha256:${'0'.repeat(64)}`,
        'X-Image-Size': String(64 * 1024 * 1024 + 1), // one byte over startTestBroker's 64 MiB cap
      },
      body: Buffer.from('irrelevant -- refused on the header alone'),
    });
    expect(res.status).toBe(413);
    expect(broker.imageLoader.calls).toHaveLength(0);
  });

  it('refuses a second push while one is still loading -- one fixed path, never two racing writers', async () => {
    broker = await startTestBroker();
    broker.imageLoader.pauseNextLoad = true;
    const firstBytes = Buffer.from('the first push, held open inside the loader');
    const firstDigest = digestOf(firstBytes);
    const firstSize = String(firstBytes.length);
    const firstHeaders = broker.signImagePushHeaders(firstDigest, firstSize);

    const firstPromise = fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: { ...firstHeaders, 'X-Image-Digest': firstDigest, 'X-Image-Size': firstSize },
      body: firstBytes,
    });

    // pushInFlight is set synchronously, well before the loader (and its
    // pause) is ever reached -- this margin is generous, not load-bearing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondBytes = Buffer.from('a second push, sent while the first is still in flight');
    const secondDigest = digestOf(secondBytes);
    const secondSize = String(secondBytes.length);
    const secondHeaders = broker.signImagePushHeaders(secondDigest, secondSize);
    const secondRes = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: { ...secondHeaders, 'X-Image-Digest': secondDigest, 'X-Image-Size': secondSize },
      body: secondBytes,
    });
    expect(secondRes.status).toBe(409);
    // Only the first push ever reached the loader -- the second was
    // refused before touching disk, let alone the loader.
    expect(broker.imageLoader.calls).toHaveLength(1);

    broker.imageLoader.release();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(200);
    expect(broker.imageLoader.calls).toHaveLength(1);
  });

  it('propagates a loader failure as a 502 without leaving its temp file behind', async () => {
    broker = await startTestBroker();
    broker.imageLoader.fail = true;
    const bytes = Buffer.from('a valid, matching stream that the loader then refuses to load');
    const digest = digestOf(bytes);
    const size = String(bytes.length);
    const headers = broker.signImagePushHeaders(digest, size);

    const res = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: { ...headers, 'X-Image-Digest': digest, 'X-Image-Size': size },
      body: bytes,
    });

    expect(res.status).toBe(502);
    expect(readdirSync(broker.imageTmpDir)).toEqual([]);
  });

  describe('structural: no file in this service ever pulls or touches a registry credential', () => {
    // Matches the *code* shape a pull, a login or a credential read would
    // actually take -- a quoted argv element, an env var name, a config
    // path -- rather than the English word, which this very file's own
    // doc comments use freely to explain what is deliberately absent.
    it.each(['imagePush.ts', 'plugins/dockerImageLoader.ts', 'controlPlanePush.ts'])(
      '%s',
      (relativePath) => {
        const source = readFileSync(join(SRC_DIR, relativePath), 'utf8');
        expect(source).not.toMatch(/['"]pull['"]/);
        expect(source).not.toMatch(/['"]login['"]/);
        expect(source).not.toMatch(/\.docker[/\\]config/);
        expect(source).not.toMatch(/DOCKER_AUTH/);
        expect(source).not.toMatch(/process\.env\.\w*(REGISTRY|CRED)/i);
      }
    );
  });
});
