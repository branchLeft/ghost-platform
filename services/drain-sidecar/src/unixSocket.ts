import type { Server } from 'node:http';
import { lstatSync, unlinkSync } from 'node:fs';
import type { Express } from 'express';

// Spelled out instead of NodeJS.ErrnoException so this file has no
// dependency on the ambient @types/node globals eslint's plain
// (non-type-aware) config doesn't resolve.
function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | undefined)?.code === 'ENOENT';
}

/**
 * Clears the path a previous run of this same service left behind, and
 * nothing else. A stale socket is the normal residue of a container that was
 * killed rather than stopped; anything at the path that is not a socket is
 * not ours to remove, so it refuses instead of deleting it.
 * See ../README.md#listening-on-a-unix-socket.
 */
export function clearStaleSocket(path: string): void {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(path).isSocket();
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  if (!isSocket) {
    throw new Error(`${path} exists and is not a socket; refusing to remove it`);
  }
  unlinkSync(path);
}

/**
 * Listens on a unix socket instead of a TCP port. The socket is created
 * under a 0177 umask so it is 0600 from the instant it exists: the only
 * process that may connect is the one running as this process's own uid.
 * Closing the server removes the socket.
 */
export function listenOnUnixSocket(app: Express, path: string): Promise<Server> {
  clearStaleSocket(path);
  return new Promise((resolve, reject) => {
    const previousUmask = process.umask(0o177);
    const server = app.listen(path);
    process.umask(previousUmask);
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      server.once('close', () => {
        try {
          unlinkSync(path);
        } catch {
          // Already gone; the next start clears whatever remains.
        }
      });
      resolve(server);
    });
  });
}
