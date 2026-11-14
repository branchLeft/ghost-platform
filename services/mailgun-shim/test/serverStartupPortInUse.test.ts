import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { freePorts } from './helpers/freePorts.js';

/**
 * Starts the real compiled entrypoint with one of its three ports already
 * taken, and requires it to exit non-zero naming EADDRINUSE without ever
 * logging that it is listening. See serverStartupPortInUse.test.md.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');

type Taken = 'mail API' | 'SMTP front door' | 'drain';

/** Holds a port on the same address the entrypoint binds for it, so the clash is the same on every OS. */
function hold(host: string | undefined): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    const onListening = (): void => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not determine the held port'));
        return;
      }
      resolve({ server, port: address.port });
    };
    if (host === undefined) server.listen(0, onListening);
    else server.listen(0, host, onListening);
  });
}

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runUntilExit(env: Record<string, string>, dir: string): Promise<Outcome> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [serverJsPath],
    {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH ?? '',
        SHIM_DB_PATH: join(dir, 'shim.sqlite'),
        SHIM_DRAIN_TOKEN: 'port-in-use-startup-proof-token',
        SMTP_LISTEN_HOST: '127.0.0.1',
        SHIM_DRAIN_HOST: '127.0.0.1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr });
    }, 8000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('src/server.ts — a taken port stops the process instead of a false "listening"', () => {
  const held: Server[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      held.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
    );
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it.each<[Taken, string | undefined]>([
    ['mail API', undefined],
    ['SMTP front door', '127.0.0.1'],
    ['drain', '127.0.0.1'],
  ])(
    'with the %s port already taken, exits non-zero naming EADDRINUSE and never logs that listener as up',
    async (taken, host) => {
      const dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-port-in-use-'));
      dirs.push(dir);
      const clash = await hold(host);
      held.push(clash.server);
      const [mail, smtp, drain] = await freePorts(3);
      const ports = {
        'mail API': taken === 'mail API' ? clash.port : mail,
        'SMTP front door': taken === 'SMTP front door' ? clash.port : smtp,
        drain: taken === 'drain' ? clash.port : drain,
      };

      const outcome = await runUntilExit(
        {
          PORT: String(ports['mail API']),
          SMTP_LISTEN_PORT: String(ports['SMTP front door']),
          SHIM_DRAIN_PORT: String(ports.drain),
        },
        dir
      );

      expect(outcome.code, `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`).not.toBeNull();
      expect(outcome.code).not.toBe(0);
      expect(outcome.stderr).toContain('EADDRINUSE');
      // The mail API and drain listeners bind in the same tick, so a taken
      // drain port can still see the mail API line first; the line for the
      // listener that could not bind is the one that must never appear.
      const neverLogged = taken === 'drain' ? '"event":"drain_listening"' : '"event":"listening"';
      expect(outcome.stdout).not.toContain(neverLogged);
    },
    15_000
  );
});
