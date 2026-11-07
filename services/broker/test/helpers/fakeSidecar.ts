import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FakeSidecar {
  readonly port: number;
  setHealthy(healthy: boolean): void;
  close(): Promise<void>;
}

function createSidecarServer(state: { healthy: boolean }): Server {
  return createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(state.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: state.healthy ? 'ok' : 'drained' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

/**
 * A stand-in for `services/drain-sidecar`'s real `/healthz` route. It answers
 * any request alike, so it cannot tell which colour was asked about; the
 * colour-aware proofs use `startRealHealthRouter` in front of
 * `startFakeSidecarOnSocket` instead.
 */
export async function startFakeSidecar(): Promise<FakeSidecar> {
  const state = { healthy: true };
  const server = createSidecarServer(state);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    setHealthy: (value) => {
      state.healthy = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface SocketSidecar {
  readonly socketPath: string;
  setHealthy(healthy: boolean): void;
  close(): Promise<void>;
}

/** The same `/healthz` route on a unix socket, where the health router reaches one colour's sidecar. */
export async function startFakeSidecarOnSocket(socketPath: string): Promise<SocketSidecar> {
  const state = { healthy: true };
  const server = createSidecarServer(state);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    setHealthy: (value) => {
      state.healthy = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface RealHealthRouter {
  /** The loopback port the router answers on, standing in for the slot's 10100+slot. */
  readonly port: number;
  /** Where the router looks for one colour's sidecar socket. */
  colourSocketPath(colour: 'a' | 'b'): string;
  close(): Promise<void>;
}

const LAUNCHER = fileURLToPath(new URL('./realHealthRouter.py', import.meta.url));

/**
 * The real `demo-host/provision/health_router.py` as a child process, over a
 * temporary socket tree with the modes and ownership it checks on every
 * request (0700 directories owned by this process's uid).
 */
export async function startRealHealthRouter(slot: string): Promise<RealHealthRouter> {
  // A short base keeps the socket path under the platform's sun_path limit.
  const base = await mkdtemp(join(tmpdir(), 'hr-'));
  const root = join(base, 'router');
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, slot), { mode: 0o700 });
  for (const colour of ['a', 'b']) await mkdir(join(root, slot, colour), { mode: 0o700 });

  const child: ChildProcess = spawn('python3', ['-I', LAUNCHER, slot, root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const cleanup = async (): Promise<void> => {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(base, { recursive: true, force: true });
  };

  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n')[0];
      if (out.includes('\n')) resolve(Number(line));
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`health router exited (${code}) before it listened: ${stderr}`))
    );
  }).catch(async (err: unknown) => {
    await cleanup();
    throw err;
  });

  return {
    port,
    colourSocketPath: (colour) => join(root, slot, colour, 'health.sock'),
    close: cleanup,
  };
}
