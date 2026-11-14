import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
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

  describe('when the deadline fires', () => {
    let stalled: Server | undefined;
    const sockets = new Set<Socket>();

    afterEach(async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const server = stalled;
      stalled = undefined;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /**
     * A receiver that answers with `status` and the start of a JSON body, then
     * goes quiet without ending the response: the headers have arrived, the
     * body read is what the deadline cuts off. `stallBeforeAnswer` withholds
     * the headers too.
     */
    async function stalledReceiver(
      status: number,
      opts: { readonly stallBeforeAnswer?: boolean } = {}
    ): Promise<string> {
      stalled = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          if (opts.stallBeforeAnswer === true) return;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.write('{"digest":');
        });
      });
      stalled.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => stalled?.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${String((stalled.address() as AddressInfo).port)}`;
    }

    async function tarOnDisk(): Promise<{ tarPath: string; digest: string }> {
      const dir = await makeTempDir('control-plane-push-');
      const tarPath = join(dir, 'image.tar');
      const bytes = Buffer.from('bytes the stalled receiver never finishes answering');
      await writeFile(tarPath, bytes);
      return { tarPath, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    }

    const TIMEOUT_MS = 300;

    function push(baseUrl: string, file: { tarPath: string; digest: string }) {
      return pushImage({
        baseUrl,
        digest: file.digest,
        tarPath: file.tarPath,
        privateKeyRaw: Buffer.alloc(32, 7),
        timeoutMs: TIMEOUT_MS,
      });
    }

    it('during the body read of a 200 answer, is thrown as the deadline error, never reported ok: true', async () => {
      const baseUrl = await stalledReceiver(200);
      await expect(push(baseUrl, await tarOnDisk())).rejects.toThrow(
        `image push did not finish within ${String(TIMEOUT_MS)} ms`
      );
    });

    it('during the body read of an error answer, is thrown as the deadline error rather than a half-read status', async () => {
      const baseUrl = await stalledReceiver(409);
      await expect(push(baseUrl, await tarOnDisk())).rejects.toThrow(
        `image push did not finish within ${String(TIMEOUT_MS)} ms`
      );
    });

    it('before any answer arrives, is thrown as the deadline error', async () => {
      const baseUrl = await stalledReceiver(200, { stallBeforeAnswer: true });
      await expect(push(baseUrl, await tarOnDisk())).rejects.toThrow(
        `image push did not finish within ${String(TIMEOUT_MS)} ms`
      );
    });
  });
});
