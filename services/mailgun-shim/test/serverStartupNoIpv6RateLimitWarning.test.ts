import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real entrypoint and checks express-rate-limit's IPv6 key
 * generator warning is absent from both output streams.
 * See serverStartupNoIpv6RateLimitWarning.test.md#no-ipv6-key-generator-warning.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverJsPath = join(projectRoot, 'dist', 'server.js');

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function build(): void {
  execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });
}

async function runServerAndCollectOutput(
  dbPath: string,
  port: number,
  smtpPort: number
): Promise<{ stdout: string; stderr: string }> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [serverJsPath],
    {
      cwd: projectRoot,
      // Deliberately not `...process.env`: this test's own shell may carry
      // ambient credentials that have nothing to do with the server under
      // test, and none of them belong in a child process or in this
      // test's own assertion diff.
      env: {
        PATH: process.env.PATH ?? '',
        SHIM_DB_PATH: dbPath,
        SHIM_DRAIN_TOKEN: 'ipv6-warning-startup-proof-token',
        PORT: String(port),
        SMTP_LISTEN_PORT: String(smtpPort),
        SMTP_LISTEN_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const check = (): void => {
      if (stdout.includes('"event":"listening"')) {
        resolve();
        return;
      }
      if (child.exitCode !== null) {
        reject(new Error(`server exited early (code ${child.exitCode}). stderr:\n${stderr}`));
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(`server never logged "listening". stdout:\n${stdout}\nstderr:\n${stderr}`)
        );
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });

  const exitPromise = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });
  child.kill('SIGTERM');
  await Promise.race([
    exitPromise,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000)
    ),
  ]);

  return { stdout, stderr };
}

describe('src/server.ts — no ERR_ERL_KEY_GEN_IPV6 warning at startup', () => {
  let dir: string;

  beforeAll(() => {
    build();
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs no ValidationError across the three mounted rate limiters', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-ipv6-warning-startup-test-'));
    const dbPath = join(dir, 'shim.sqlite');

    const port = await findFreePort();
    const smtpPort = await findFreePort();
    const { stdout, stderr } = await runServerAndCollectOutput(dbPath, port, smtpPort);

    expect(stderr).not.toContain('ValidationError');
    expect(stderr).not.toContain('ERR_ERL_KEY_GEN_IPV6');
    expect(stdout).not.toContain('ValidationError');
    expect(stdout).not.toContain('ERR_ERL_KEY_GEN_IPV6');
  }, 20_000);
});
