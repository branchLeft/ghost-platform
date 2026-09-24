/**
 * The real control BLOCKING finding 1 on workspace#1183's review asked
 * for: a rendered demo does not merely write seven files — it runs.
 * Renders the demo golden fixture's own `compose.yml` (the actual `render()`
 * output, not a hand-written stand-in), provisions its three external
 * volumes exactly as `#1188`'s eventual host-build step would, starts
 * `ghost-a` for real against the platform image, and asserts Ghost answers
 * on loopback while never publishing on the private-IP-shaped address a
 * demo's own `appHostIp` field carries.
 *
 * Needs Docker and the `ghost-platform:ci` image (built by this repo's
 * `docker build .` at the repo root — see `build.yml`'s "docker build" job,
 * which already builds and smoke-tests it on every PR). `render-core-ci.yml`
 * runs `npm ci`/test/coverage inside `render-core/` only and never builds
 * that image, so this suite detects its absence and skips rather than
 * failing a CI job that has no way to produce it — proven locally, where
 * both preconditions hold, and recorded as run in the PR body.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(here, 'golden', 'demo.compose.yml');
const IMAGE = 'ghost-platform:ci';
const PROJECT = `render-core-live-proof-${process.pid}`;
const CONTAINER = `${PROJECT}-ghost-a-1`;
// Must match render-core's own naming for the demo golden fixture
// (demoDescriptor(): slug "demo-1", uid 30001) — see compose.ts/render.ts.
const VOLUMES = ['ghost-demo-1-content', 'ghost-demo-1-adapters', 'ghost-demo-30001-data'];
const LOOPBACK_PORT = 3001; // demoDescriptor().ports.a

function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return result.status === 0;
}

function imageAvailable(): boolean {
  const result = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
  return result.status === 0;
}

const canRun = dockerAvailable() && imageAvailable();

function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, IMAGE },
  });
}

async function waitForHttp200(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Ghost's own `url` config is https, so a probe carrying no
      // X-Forwarded-Proto reads as insecure and gets a 301 forever — see
      // compose.ts's own healthcheck, which carries the same header for
      // the same reason.
      const res = await fetch(url, {
        headers: { 'X-Forwarded-Proto': 'https' },
        redirect: 'manual',
      });
      if (res.status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

describe.skipIf(!canRun)(
  'LIVE — a rendered demo actually runs (docker compose + the real image)',
  () => {
    beforeAll(() => {
      // Host-provisioned once, at demo-host build time, in production — see
      // compose.ts's own DemoDataMount comment. Simulated here with a
      // one-off root container doing exactly what that provisioning step
      // must: create each external volume and chown it to the slot's uid,
      // because a fresh Docker named volume is root-owned and the container
      // runs as 30001:30001 with `read_only: true`.
      for (const volume of VOLUMES) {
        execFileSync('docker', ['volume', 'create', volume], { stdio: 'ignore' });
        execFileSync(
          'docker',
          ['run', '--rm', '-v', `${volume}:/data`, 'alpine', 'chown', '-R', '30001:30001', '/data'],
          { stdio: 'ignore' }
        );
      }
    }, 30_000);

    afterAll(() => {
      try {
        compose('down', '--timeout', '5');
      } catch {
        // best-effort
      }
      for (const volume of VOLUMES) {
        spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      }
    }, 30_000);

    it('boots the real image from the rendered compose.yml and answers on loopback', async () => {
      const golden = readFileSync(COMPOSE_FILE, 'utf-8');
      expect(golden).toContain("- '127.0.0.1:3001:2368'"); // control: this is the artefact under test

      compose('up', '-d', 'ghost-a');

      const ready = await waitForHttp200(`http://127.0.0.1:${LOOPBACK_PORT}/`, 60_000);
      if (!ready) {
        const logs = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf-8' });
        throw new Error(`demo never answered 200 on loopback within 60s. Container logs:\n${logs}`);
      }
      expect(ready).toBe(true);
    }, 70_000);

    it("publishes only on 127.0.0.1 — never on the descriptor's own private appHostIp", () => {
      // GREEN: `docker port` reports the actual bound host address Docker
      // published, read back from the running container rather than
      // asserted from the YAML alone.
      const portOutput = execFileSync('docker', ['port', CONTAINER], { encoding: 'utf-8' });
      expect(portOutput).toContain('127.0.0.1:3001');
      // demoDescriptor().appHostIp — the address LLD-2 §01b's own load-bearing
      // ruling says a demo must never be reachable on.
      expect(portOutput).not.toContain('10.20.1.50');
      expect(portOutput).not.toContain('0.0.0.0');
    });
  }
);

describe.skipIf(canRun)('LIVE demo-boot proof — skipped', () => {
  it('needs Docker and the ghost-platform:ci image locally; not run in render-core-ci.yml', () => {
    expect(canRun).toBe(false);
  });
});
