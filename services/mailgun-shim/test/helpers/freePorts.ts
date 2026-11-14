import { createServer, type Server } from 'node:net';

/**
 * Loopback ports for a test that starts the compiled entrypoint as a child
 * process. server.ts reads PORT and SMTP_LISTEN_PORT from the environment and
 * treats 0 as unset, so unlike an in-process listener the child cannot be told
 * to bind port 0 and report back: the test must hand it numbers. Handing over
 * a number picked earlier leaves a gap before the child binds it, in which
 * another test file (vitest runs files in parallel) or any other process on
 * the runner can take it. This module narrows that gap to the one window that
 * cannot be removed and makes a collision inside it harmless by running the
 * whole start again on fresh ports. See freePorts.md.
 */

const DEFAULT_MAX_ATTEMPTS = 5;

type Ports<N extends number, Acc extends number[] = []> = Acc['length'] extends N
  ? Acc
  : Ports<N, [...Acc, number]>;

function listenOnAnyPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not determine a free port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/**
 * `count` distinct free loopback ports. Every probe stays bound until all of
 * them are read, so two of the numbers can never be the same; they are
 * released together on return.
 */
export async function freePorts<N extends number>(count: N): Promise<Ports<N>> {
  const servers: Server[] = [];
  try {
    const ports: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const server = createServer();
      servers.push(server);
      ports.push(await listenOnAnyPort(server));
    }
    return ports as Ports<N>;
  } finally {
    await Promise.all(servers.map(closeServer));
  }
}

/**
 * True for an error that says a port was taken: a Node error carrying the
 * code, or a failure message that quotes it, as a child's stderr does when
 * the test reports why the server exited early.
 */
export function isAddressInUse(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return code === 'EADDRINUSE' || err.message.includes('EADDRINUSE');
  }
  return false;
}

/**
 * Runs `attempt` with `count` fresh ports. If it fails because a port was
 * already in use, runs it again on a new set, up to `maxAttempts` times in
 * all; any other failure, and the last collision, propagate untouched. The
 * attempt must start everything it needs and clean up after itself, because
 * it can run more than once.
 */
export async function withFreePorts<N extends number, T>(
  count: N,
  attempt: (ports: Ports<N>) => Promise<T>,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS
): Promise<T> {
  for (let n = 1; ; n += 1) {
    const ports = await freePorts(count);
    try {
      return await attempt(ports);
    } catch (err) {
      if (!isAddressInUse(err) || n >= maxAttempts) throw err;
    }
  }
}
