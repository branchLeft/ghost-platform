import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import { FILE_BODY_CHUNK_BYTES, fileBodyStream } from '../../src/fileBodyStream.js';

/**
 * The uncaught error these guard against was seen live: pushing a ~GB tar
 * under Node 26 died with `ERR_INVALID_STATE: Controller is already closed at
 * ReadableStreamDefaultController.enqueue (node:internal/webstreams/adapters)`
 * -- the failure of an upload must be a rejected promise, never a crash.
 */
describe('fileBodyStream (a file as a streamed request body)', () => {
  let dir: string;
  let uncaught: Error[];
  const onUncaught = (error: Error): void => {
    uncaught.push(error);
  };

  beforeEach(async () => {
    dir = await makeTempDir('file-body-stream-');
    uncaught = [];
    // vitest reports an uncaught exception as a failed run on its own, which
    // would hide the assertion that names it; collect them for this test.
    process.on('uncaughtException', onUncaught);
  });

  afterEach(() => {
    process.off('uncaughtException', onUncaught);
  });

  async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  it('delivers every byte of a multi-chunk file, in order, and ends', async () => {
    const bytes = randomBytes(FILE_BODY_CHUNK_BYTES * 3 + 123);
    const path = join(dir, 'a.tar');
    await writeFile(path, bytes);
    expect((await readAll(fileBodyStream(path))).equals(bytes)).toBe(true);
  });

  it('ends at once for an empty file', async () => {
    const path = join(dir, 'empty.tar');
    await writeFile(path, Buffer.alloc(0));
    expect((await readAll(fileBodyStream(path))).length).toBe(0);
  });

  it('a file that cannot be opened is the stream failing, not a throw from nowhere', async () => {
    const stream = fileBodyStream(join(dir, 'missing.tar'));
    await expect(readAll(stream)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancelling while a read is pending and more is buffered never throws out of band', async () => {
    const path = join(dir, 'big.tar');
    await writeFile(path, randomBytes(FILE_BODY_CHUNK_BYTES * 8));
    for (let i = 0; i < 25; i++) {
      const reader = fileBodyStream(path).getReader();
      await reader.read();
      await new Promise((resolve) => setTimeout(resolve, 5)); // let the source get ahead of the consumer
      const pending = reader.read(); // asks the source for more...
      await reader.cancel(new Error('peer gone')); // ...and the peer goes away in the same breath
      await pending.catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(uncaught.map((e) => e.message)).toEqual([]);
  });

  it('cancelling before the first read, and cancelling twice, are both quiet', async () => {
    const path = join(dir, 'c.tar');
    await writeFile(path, randomBytes(1000));
    const stream = fileBodyStream(path);
    await stream.cancel(new Error('never needed'));
    await expect(stream.cancel()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uncaught).toEqual([]);
  });
});
