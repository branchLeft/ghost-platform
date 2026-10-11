import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../src/atomicFile.js';
import { pushImage } from '../src/controlPlanePush.js';
import { handleImagePush } from '../src/imagePush.js';
import { createInMemoryNonceStore } from '../src/nonceStore.js';
import { generateTestKeyPair } from '../test/helpers/signer.js';

/**
 * `handleImagePush` is the whole of a push as one call that writes its own
 * response. The broker no longer routes through it (it reaches the same
 * steps through the generated adapter), but the live-proof receiver
 * (`test/live/fixtures/hostReceiver.mjs`) calls it directly, and that proof
 * only runs where Docker and a Ghost image are present. This keeps the
 * entry point proven where they are not, and drives it with the real
 * `pushImage`, which now goes through the generated client.
 */
describe('handleImagePush, driven by the real generated-client pushImage', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function host() {
    const keyPair = generateTestKeyPair();
    const tmpDir = await makeTempDir('whole-flow-host-');
    const loaded: string[] = [];
    const nowMs = Date.now();
    server = createServer((req, res) => {
      void handleImagePush(
        {
          verifyKey: keyPair.publicKeyRaw,
          replayWindowSeconds: 60,
          nonces: createInMemoryNonceStore(60_000),
          processStartSeconds: Math.floor(nowMs / 1000) - 10,
          nowMs: () => Date.now(),
        },
        {
          loader: {
            async load(tarPath) {
              loaded.push(tarPath);
              return { imageId: `sha256:${'a'.repeat(64)}` };
            },
          },
          tmpDir,
          maxBytes: 1024 * 1024,
          nowMs: () => Date.now(),
          log: () => undefined,
        },
        req,
        res
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { keyPair, loaded, baseUrl: `http://127.0.0.1:${port}`, tmpDir };
  }

  it('loads a push whose digest matches, and reports it back through the generated client', async () => {
    const { keyPair, loaded, baseUrl, tmpDir } = await host();
    const tarPath = join(tmpDir, 'sent.tar');
    const bytes = Buffer.from('whole-flow tar bytes');
    await writeFile(tarPath, bytes);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

    const result = await pushImage({
      baseUrl,
      digest,
      tarPath,
      privateKeyRaw: keyPair.privateKeyRaw,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ digest, bytes: bytes.length });
    expect(loaded).toHaveLength(1);
  });

  it('refuses a wrong digest with the declared and received values, and loads nothing', async () => {
    const { keyPair, loaded, baseUrl, tmpDir } = await host();
    const tarPath = join(tmpDir, 'sent.tar');
    await writeFile(tarPath, Buffer.from('other bytes'));
    const declared = `sha256:${'0'.repeat(64)}`;

    const result = await pushImage({
      baseUrl,
      digest: declared,
      tarPath,
      privateKeyRaw: keyPair.privateKeyRaw,
    });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ declared });
    expect(loaded).toHaveLength(0);
  });

  it('refuses a malformed digest header before it looks at the signature', async () => {
    const { keyPair, loaded, baseUrl, tmpDir } = await host();
    const tarPath = join(tmpDir, 'sent.tar');
    await writeFile(tarPath, Buffer.from('x'));

    const result = await pushImage({
      baseUrl,
      digest: 'not-a-digest',
      tarPath,
      privateKeyRaw: keyPair.privateKeyRaw,
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: expect.stringContaining('x-image-digest') });
    expect(loaded).toHaveLength(0);
  });

  it('rejects, rather than reporting a status, when nothing is listening', async () => {
    const { keyPair, baseUrl, tmpDir } = await host();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const tarPath = join(tmpDir, 'sent.tar');
    await writeFile(tarPath, Buffer.from('x'));

    await expect(
      pushImage({
        baseUrl,
        digest: `sha256:${'0'.repeat(64)}`,
        tarPath,
        privateKeyRaw: keyPair.privateKeyRaw,
      })
    ).rejects.toBeDefined();
  });

  it('refuses an unsigned push with the reason in the body', async () => {
    const { baseUrl, tmpDir } = await host();
    const tarPath = join(tmpDir, 'sent.tar');
    await writeFile(tarPath, Buffer.from('x'));
    const digest = `sha256:${createHash('sha256').update('x').digest('hex')}`;

    const result = await pushImage({
      baseUrl,
      digest,
      tarPath,
      privateKeyRaw: Buffer.alloc(32, 7),
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: expect.any(String) });
  });
});
