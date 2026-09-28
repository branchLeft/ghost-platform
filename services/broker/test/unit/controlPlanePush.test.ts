import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pushImage } from '../../src/controlPlanePush.js';
import { makeTempDir } from '../../src/atomicFile.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

/**
 * `pushImage` is the control-plane half of the same real router
 * `imagePush.test.ts` drives from the receiver side -- run against the same
 * real `startTestBroker()` broker rather than a hand-rolled HTTP double, so
 * this proves the client and the server actually agree on the signed
 * manifest's exact bytes, not two independent implementations of the same
 * idea.
 */
describe('pushImage (the control-plane side of push delivery)', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it('streams a real file from disk and the receiver loads it on a matching digest', async () => {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-push-');
    const tarPath = join(dir, 'image.tar');
    const bytes = Buffer.from('stand-in tar bytes, streamed from a real file on disk');
    await writeFile(tarPath, bytes);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

    const result = await pushImage({
      baseUrl: broker.baseUrl,
      digest,
      tarPath,
      privateKeyRaw: broker.keyPair.privateKeyRaw,
      nowSeconds: Math.floor(broker.nowMs() / 1000),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ digest, bytes: bytes.length });
    expect(broker.imageLoader.calls).toHaveLength(1);
  });

  it('a wrong digest is refused by the real receiver, and reported back rather than thrown', async () => {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-push-');
    const tarPath = join(dir, 'image.tar');
    await writeFile(tarPath, Buffer.from('some bytes'));

    const result = await pushImage({
      baseUrl: broker.baseUrl,
      digest: `sha256:${'0'.repeat(64)}`, // does not match the file's real content
      tarPath,
      privateKeyRaw: broker.keyPair.privateKeyRaw,
      nowSeconds: Math.floor(broker.nowMs() / 1000),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(broker.imageLoader.calls).toHaveLength(0);
  });

  it('a push signed with the wrong key is refused (proves it actually signs -- not merely well-formed headers)', async () => {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-push-');
    const tarPath = join(dir, 'image.tar');
    const bytes = Buffer.from('some bytes');
    await writeFile(tarPath, bytes);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

    const result = await pushImage({
      baseUrl: broker.baseUrl,
      digest,
      tarPath,
      privateKeyRaw: Buffer.alloc(32, 9), // not the broker's configured key
      nowSeconds: Math.floor(broker.nowMs() / 1000),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});
