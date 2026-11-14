import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, startRig } from './support/gateway-rig.js';

// The process entry, as the image runs it: compiled with the package's own
// build configuration, then started as a separate process and sent SIGTERM.

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let built: string;

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), 'gw-built-'));
  const compile = spawnSync(
    process.execPath,
    [
      join(pkg, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(pkg, 'tsconfig.build.json'),
      '--outDir',
      join(built, 'dist'),
    ],
    { cwd: pkg, encoding: 'utf8' }
  );
  if (compile.status !== 0) throw new Error(`build failed: ${compile.stdout}`);
  // The layout the image has: dist, drizzle and node_modules beside package.json.
  await copyFile(join(pkg, 'package.json'), join(built, 'package.json'));
  await symlink(join(pkg, 'drizzle'), join(built, 'drizzle'));
  await symlink(join(pkg, 'node_modules'), join(built, 'node_modules'));
}, 90_000);

afterAll(async () => {
  await rm(built, { recursive: true, force: true });
});

function start(env: Record<string, string>): {
  child: ChildProcess;
  lines: string[];
  exited: Promise<number>;
} {
  const child = spawn(process.execPath, [join(built, 'dist/main.js')], {
    cwd: built,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines: string[] = [];
  let pending = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    lines.push(...parts);
  });
  const exited = new Promise<number>((done) => child.on('exit', (code) => done(code ?? -1)));
  return { child, lines, exited };
}

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !test(); i += 1) await new Promise((r) => setTimeout(r, 50));
  expect(test()).toBe(true);
}

describe('the process entry', () => {
  it('serves, then drains and exits 0 on SIGTERM', async () => {
    const rig = await startRig();
    try {
      await rig.gateway.stop();
      // The admin interface needs root-owned key files; it is proved in-process.
      const { STORAGE_GATEWAY_ADMIN_KEYS_FILE: _admin, ...env } = rig.env;
      const running = start(env);
      await until(() => running.lines.some((l) => l.includes('"message":"listening"')));
      const port = Number(
        (
          JSON.parse(running.lines.find((l) => l.includes('"listening"')) ?? '{}') as {
            detail?: string;
          }
        ).detail
      );
      expect((await call(port, 'GET', '/readyz', {})).status).toBe(200);

      running.child.kill('SIGTERM');
      expect(await running.exited).toBe(0);
      const log = running.lines.join('\n');
      expect(log).toContain('"message":"signal received"');
      expect(log).toContain('"message":"draining"');
      expect(log).toContain('"message":"stopped"');
    } finally {
      await rig.stop();
    }
  }, 30_000);

  it('refuses to start with no configuration, exits 1, and names the setting and no value', async () => {
    const running = start({});
    expect(await running.exited).toBe(1);
    const log = running.lines.join('\n');
    expect(log).toContain('"message":"refusing to start"');
    expect(log).toContain('STORAGE_GATEWAY_REGION is not set');
  });
});
