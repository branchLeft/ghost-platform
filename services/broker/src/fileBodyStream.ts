import { open, type FileHandle } from 'node:fs/promises';

/** How much one `pull()` reads; one chunk is queued at a time, so this is also the memory held per push. */
export const FILE_BODY_CHUNK_BYTES = 256 * 1024;

/**
 * A file as a web `ReadableStream`, for use as a streamed request body.
 *
 * Not `Readable.toWeb(createReadStream(path))`: that adapter's `cancel()`
 * destroys the Node stream but a `resume()` queued by an earlier `pull()` can
 * still flow buffered bytes afterwards, and its `data` listener then calls
 * `controller.enqueue` on the already-cancelled stream. That throws
 * `ERR_INVALID_STATE: Controller is already closed` from inside an event
 * emit, where nothing can catch it, so the process dies instead of the push
 * failing. fetch cancels the body whenever the peer goes away first (a reset,
 * the deadline, an early answer), so a drop mid-upload was fatal.
 *
 * Here one `read()` is in flight at most, only ever started by `pull()`, and
 * the handle is closed after that read settles; a read that finishes after a
 * cancel is dropped without touching the controller. Every failure (open, read)
 * reaches the consumer as the stream's error, i.e. a rejected `fetch`.
 */
export function fileBodyStream(path: string): ReadableStream<Uint8Array> {
  let handle: FileHandle | undefined;
  let cancelled = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const closeHandle = async (): Promise<void> => {
    const h = handle;
    handle = undefined;
    if (h !== undefined) await h.close().catch(() => undefined);
  };

  return new ReadableStream<Uint8Array>(
    {
      async start() {
        handle = await open(path, 'r');
      },
      pull(controller) {
        const h = handle;
        if (h === undefined) return undefined;
        const read = (async (): Promise<void> => {
          const buffer = Buffer.allocUnsafe(FILE_BODY_CHUNK_BYTES);
          try {
            const { bytesRead } = await h.read(buffer, 0, buffer.length, null);
            if (cancelled) return;
            if (bytesRead === 0) {
              await closeHandle();
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
          } catch (error) {
            await closeHandle();
            if (!cancelled) controller.error(error);
          }
        })();
        inFlight = read;
        return read;
      },
      async cancel() {
        cancelled = true;
        await inFlight;
        await closeHandle();
      },
    },
    { highWaterMark: 1 }
  );
}
