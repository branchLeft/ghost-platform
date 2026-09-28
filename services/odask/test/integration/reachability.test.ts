import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The load-bearing control (LLD-5 E2): spawns the actual built entrypoint
 * with real environment variables, not `createApp(...).listen(...)`
 * called directly, because the property under test is what the shipped
 * process does with `config.bindHost`. `127.0.0.2` was tried and
 * rejected as the non-loopback probe address -- see sabotage
 * reproduction steps and platform notes.
 * See ../../README.md#reachability-test-load-bearing-control.
 */
const otherInterfaceAddress = (): string | undefined => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return undefined;
};

const OTHER_ADDRESS = otherInterfaceAddress();
const SERVER_ENTRYPOINT = fileURLToPath(new URL('../../dist/server.js', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

interface RunningServer {
  port: number;
  kill: () => Promise<void>;
}

/** Spawns the real, built entrypoint with real env vars and waits for it to report itself listening. */
async function spawnRealServer(bindHost: string): Promise<RunningServer> {
  const port = await freePort();
  const descriptorDir = mkdtempSync(join(tmpdir(), 'odask-reachability-'));
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [SERVER_ENTRYPOINT],
    {
      env: {
        PATH: process.env.PATH,
        BIND_HOST: bindHost,
        DESCRIPTOR_DIR: descriptorDir,
        BASE_DOMAIN: 'sites.publicpress.co.uk',
        OWNED_DOMAINS: 'publicpress.co.uk,sites.publicpress.co.uk',
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      reject(new Error(`odask exited early (code ${code}): ${stderr}`));
    });
  });

  const listening = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('odask listening on')) {
        resolve();
      }
    });
  });

  try {
    await Promise.race([
      listening,
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('odask did not report listening within 5s')), 5000)
      ),
    ]);
  } catch (error) {
    // The process never reached a state kill() would otherwise clean up
    // after (it exited on its own, or timed out) -- this is the only
    // place that outcome's descriptor dir gets removed.
    rmSync(descriptorDir, { recursive: true, force: true });
    throw error;
  }

  return {
    port,
    kill: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => {
          rmSync(descriptorDir, { recursive: true, force: true });
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}

/** A bounded connect attempt: resolves 'connected' or the refusal reason, never hangs the suite. */
function tryConnect(host: string, port: number): Promise<'connected' | 'refused' | 'timeout'> {
  return new Promise((resolve) => {
    const socket: Socket = connect({ host, port, timeout: 1500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', () => {
      resolve('refused');
    });
  });
}

let kill: (() => Promise<void>) | undefined;

afterEach(async () => {
  await kill?.();
  kill = undefined;
});

describe.skipIf(OTHER_ADDRESS === undefined)(
  "network reachability of the real entrypoint (LLD-5 E2, done-means's control case)",
  () => {
    it('the real dist/server.js is not reachable on any interface but the one it was bound to', async () => {
      const server = await spawnRealServer('127.0.0.1');
      kill = server.kill;

      // The control case: the server *is* reachable on the interface it
      // was actually bound to. Without this, a refusal on OTHER_ADDRESS
      // below would be indistinguishable from the process never starting.
      expect(await tryConnect('127.0.0.1', server.port)).toBe('connected');

      // The load-bearing assertion, against the real process rather than
      // a local listen() call: nothing but that one interface can reach
      // it, including the host's other real, already-up interface.
      expect(await tryConnect(OTHER_ADDRESS!, server.port)).toBe('refused');
    }, 10000);
  }
);

/**
 * Four spellings that all normalise to "every interface" at the kernel
 * (Node's own `net` module), none of which `config.ts`'s string check
 * happens to list. Each is proven against the real built entrypoint: the
 * process must refuse to run, not merely start and (as it did before this
 * fix) still answer on an interface the string check never considered.
 */
describe('the real dist/server.js refuses to run on any BIND_HOST that resolves to every interface', () => {
  it.each(['0', '::0', '0::', '::ffff:0.0.0.0'])('%j', async (bindHost) => {
    await expect(spawnRealServer(bindHost)).rejects.toThrow(
      /exited early \(code 1\).*every interface/s
    );
  });
});
