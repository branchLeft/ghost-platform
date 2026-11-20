/**
 * The network deny, run for real. Renders a slot's stack, starts its
 * `verdict-host` sidecar from the rendered file (the real host end, on the
 * rendered `internal: true` network, with the rendered posture), and attempts
 * outbound connects from inside it. Needs Docker, an image that has Node, and
 * the host end's built `signed-request.cjs`; skips rather than fails when any
 * is absent. See verdict-host-network.md.
 *
 * Control, by sabotage: the same run against the same rendered file with the
 * `internal: true` line removed (a network with a gateway) must reach the
 * canary, and the refusal assertion must fail on it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Port, PrivateIpV4, Slug, TenantUid } from '../src/brand.js';
import type { ComposeStackArgs } from '../src/compose.js';
import {
  VERDICT_HOST_ENTRYPOINT,
  VERDICT_HOST_LIMITS,
  renderComposeStack,
} from '../src/compose.js';
import { verdictJournalVolumeName, verdictNetworkName, verdictVolumeName } from '../src/naming.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCANNING_TREE = resolve(here, '..', '..', 'adapters', 'scanning-storage');
const BUNDLE = join(SCANNING_TREE, 'verdict-host', 'generated', 'signed-request.cjs');
const IMAGE = process.env.VERDICT_NETWORK_TEST_IMAGE ?? 'ghost-platform:ci';

const SLUG = `vhn-${process.pid}` as Slug;
const UID = 30123 as TenantUid;
const PROJECT = `render-core-verdict-net-${process.pid}`;
const SERVICE = 'verdict-host';
const NETWORK = verdictNetworkName(SLUG);
const VOLUMES = [verdictVolumeName(SLUG), verdictJournalVolumeName(SLUG)];
const KEY_MOUNT = '/run/verdict-verify.key';
const PUBLIC_ADDRESS = '1.1.1.1';

const STACK: ComposeStackArgs = {
  kind: 'tenant',
  slug: SLUG,
  uid: UID,
  appHostPrivateIp: '10.20.1.50' as PrivateIpV4,
  ports: { a: 3101 as Port, b: 3102 as Port, health: 3103 as Port },
  environment: { url: 'https://blog.example.test' },
  limits: {
    tmpfsSize: '128m',
    themeCompressedBytes: 1,
    themeEntryUncompressedBytes: 1,
    themeTotalUncompressedBytes: 1,
    edgeRequestBodyMaxSize: '64MiB',
    memoryLimit: '640m',
  },
  caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
  dataMount: null,
  mailNetwork: null,
  verdictVolume: verdictVolumeName(SLUG),
};

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function dockerUsable(): boolean {
  return (
    spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 &&
    spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0
  );
}

const canRun = dockerUsable() && existsSync(BUNDLE);

/** One outbound connect attempt, as the probe inside the container reports it. */
interface Attempt {
  readonly target: string;
  readonly outcome: 'connected' | 'error';
  readonly code: string;
}

interface Run {
  readonly attempts: readonly Attempt[];
  readonly canaryConnections: number;
  readonly inspect: Record<string, unknown>;
  readonly networkInternal: boolean;
  readonly logs: string;
}

// Run inside the container by `node -e`, a process of its own: the host end's
// in-process egress guard is not installed in it, so a refusal here is the
// network's, not the guard's.
const PROBE = `
const net = require('node:net');
const targets = JSON.parse(process.argv[1]);
const results = [];
let pending = targets.length;
for (const [host, port] of targets) {
  const socket = net.connect({ host, port });
  const finish = (outcome, code) => {
    if (socket.destroyed && results.some((r) => r.target === host + ':' + port)) return;
    results.push({ target: host + ':' + port, outcome, code });
    socket.destroy();
    if (--pending === 0) { console.log(JSON.stringify(results)); process.exit(0); }
  };
  socket.setTimeout(4000, () => finish('error', 'ETIMEDOUT'));
  socket.once('connect', () => finish('connected', 'OK'));
  socket.once('error', (err) => finish('error', err.code || String(err.message)));
}
`;

function publicKeyBase64(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

/**
 * Starts the sidecar from `composeText` and attempts outbound connects from
 * inside it. Runs one container, and removes it, its network and its volumes
 * before it returns.
 */
async function runSidecar(composeText: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-net-'));
  const composeFile = join(dir, 'compose.yml');
  const overrideFile = join(dir, 'override.yml');
  const keyFile = join(dir, 'verify.key');
  writeFileSync(composeFile, composeText);
  writeFileSync(keyFile, `${publicKeyBase64()}\n`);

  const canary = net.createServer((socket) => {
    canaryConnections += 1;
    socket.destroy();
  });
  let canaryConnections = 0;
  await new Promise<void>((done) => canary.listen(0, '0.0.0.0', done));
  const canaryPort = (canary.address() as net.AddressInfo).port;

  // Only what the render leaves to other changes, and the canary route: the
  // image's own copy of the host end (the image does not carry it yet), its
  // verify key and its inbound port. Nothing here touches the network, the
  // posture or the entrypoint the render wrote.
  writeFileSync(
    overrideFile,
    JSON.stringify({
      services: {
        [SERVICE]: {
          environment: {
            VERDICT_HOST_VERIFY_KEY_FILE: KEY_MOUNT,
            VERDICT_HOST_INBOUND_PORT: '8080',
          },
          volumes: [
            `${SCANNING_TREE}:${dirname(dirname(VERDICT_HOST_ENTRYPOINT))}:ro`,
            `${keyFile}:${KEY_MOUNT}:ro`,
          ],
          extra_hosts: ['host.docker.internal:host-gateway'],
        },
      },
    })
  );

  const compose = (...args: string[]): string =>
    execFileSync(
      'docker',
      ['compose', '-f', composeFile, '-f', overrideFile, '-p', PROJECT, ...args],
      { encoding: 'utf-8', env: { ...process.env, IMAGE }, stdio: ['ignore', 'pipe', 'pipe'] }
    );

  try {
    for (const volume of VOLUMES) {
      docker('volume', 'create', volume);
      // A fresh named volume is root-owned and the host end runs as the slot's
      // uid, so the way a host's provisioning step would, hand it over.
      docker(
        'run',
        '--rm',
        '--user',
        '0',
        '--entrypoint',
        'chown',
        '-v',
        `${volume}:/v`,
        IMAGE,
        `${UID}:${UID}`,
        '/v'
      );
    }
    try {
      compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '90', SERVICE);
    } catch (error) {
      // Say why it did not come up: the host end's own log line.
      const why = spawnSync(
        'docker',
        [
          'compose',
          '-f',
          composeFile,
          '-f',
          overrideFile,
          '-p',
          PROJECT,
          'logs',
          '--no-color',
          SERVICE,
        ],
        {
          encoding: 'utf-8',
          env: { ...process.env, IMAGE },
        }
      );
      throw new Error(`the sidecar did not become healthy:\n${why.stdout}${why.stderr}`, {
        cause: error,
      });
    }

    const container = compose('ps', '-q', SERVICE).trim();
    const probe = docker(
      'exec',
      container,
      'node',
      '-e',
      PROBE,
      JSON.stringify([
        ['host.docker.internal', canaryPort],
        [PUBLIC_ADDRESS, 443],
      ])
    );
    // Docker Desktop forwards a published-to-host connect through a proxy, so
    // the canary's own accept can lag the probe's `connect` by a moment.
    await new Promise((done) => setTimeout(done, 2000));
    return {
      attempts: JSON.parse(probe.trim()) as Attempt[],
      canaryConnections,
      inspect: (JSON.parse(docker('inspect', container)) as Record<string, unknown>[])[0],
      networkInternal:
        docker('network', 'inspect', NETWORK, '--format', '{{.Internal}}').trim() === 'true',
      logs: compose('logs', '--no-color', SERVICE),
    };
  } finally {
    spawnSync(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        '-f',
        overrideFile,
        '-p',
        PROJECT,
        'down',
        '--remove-orphans',
        '-t',
        '2',
      ],
      {
        stdio: 'ignore',
        env: { ...process.env, IMAGE },
      }
    );
    for (const volume of VOLUMES)
      spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
    spawnSync('docker', ['network', 'rm', NETWORK], { stdio: 'ignore' });
    await new Promise<void>((done) => canary.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The control's own assertion: no outbound connect reached anything. */
function assertOutboundDenied(run: Run): void {
  const reached = run.attempts.filter((attempt) => attempt.outcome === 'connected');
  expect(reached, 'outbound connects that succeeded').toEqual([]);
  expect(run.canaryConnections, 'connections the host-side canary saw').toBe(0);
  for (const attempt of run.attempts) {
    expect(attempt.outcome).toBe('error');
  }
}

describe.skipIf(!canRun)(
  'LIVE — the rendered verdict host end has no route off its network',
  () => {
    const rendered = renderComposeStack(STACK);
    let denied: Run;
    let routed: Run;

    beforeAll(async () => {
      denied = await runSidecar(rendered);
      // One container at a time: the second starts after the first is removed.
      routed = await runSidecar(rendered.replace('    internal: true\n', ''));
    }, 300_000);

    afterAll(() => {
      for (const volume of VOLUMES)
        spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      spawnSync('docker', ['network', 'rm', NETWORK], { stdio: 'ignore' });
    });

    it('is rendered with the network internal, and the control variant differs by that line alone', () => {
      expect(rendered).toContain(`  ${NETWORK}:\n    name: '${NETWORK}'\n    internal: true\n`);
      expect(rendered.replace('    internal: true\n', '')).not.toBe(rendered);
    });

    it('runs the real host end on the rendered network, and only that one', () => {
      expect(denied.logs).toContain('VERDICT_HOST_READY');
      expect(denied.networkInternal).toBe(true);
      const settings = denied.inspect.NetworkSettings as { Networks: Record<string, unknown> };
      expect(Object.keys(settings.Networks)).toEqual([NETWORK]);
    });

    it('runs with the rendered posture: read-only, no capabilities, no new privileges, limited, unpublished', () => {
      const host = denied.inspect.HostConfig as Record<string, unknown>;
      expect(host.ReadonlyRootfs).toBe(true);
      expect(host.CapDrop).toEqual(['ALL']);
      expect(host.SecurityOpt).toContain('no-new-privileges:true');
      expect(host.Memory).toBe(192 * 1024 * 1024);
      expect(host.MemorySwap).toBe(192 * 1024 * 1024);
      expect(host.PidsLimit).toBe(VERDICT_HOST_LIMITS.pidsLimit);
      expect(host.PortBindings).toEqual({});
      expect((denied.inspect.Config as { User: string }).User).toBe(`${UID}:${UID}`);
    });

    it('an outbound connect from inside it fails, to the host and to a public address', () => {
      expect(denied.attempts).toHaveLength(2);
      assertOutboundDenied(denied);
    });

    it('CONTROL — the same stack on a network with a gateway reaches the canary, so the refusal assertion goes red on it', () => {
      expect(routed.networkInternal).toBe(false);
      expect(routed.canaryConnections, JSON.stringify(routed.attempts)).toBeGreaterThan(0);
      expect(routed.attempts.some((attempt) => attempt.outcome === 'connected')).toBe(true);
      // RED: the assertion the rendered stack passes fails on the variant.
      expect(() => assertOutboundDenied(routed)).toThrow();
    });
  }
);

describe('the live network proof needs Docker', () => {
  it('skips, rather than fails, without Docker, the image or the built host end', () => {
    expect(typeof canRun).toBe('boolean');
  });
});
