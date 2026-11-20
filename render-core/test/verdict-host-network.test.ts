/**
 * The network deny, run for real. Renders a slot's stack, starts its
 * `verdict-host` sidecar from the rendered file (the real host end, with the
 * rendered `network_mode: none` and the rendered posture), and attempts
 * outbound connects from inside it, to a canary listening on every address of
 * the Docker host, to the host-gateway address, to the default bridge's
 * gateway and to a public address. Needs Docker, an image that has Node, and
 * the host end's built `signed-request.cjs`; skips rather than fails when any
 * is absent. See verdict-host-network.md.
 *
 * Two controls, by sabotage, each run against the same rendered file with the
 * `network_mode` line replaced, each of which the refusal assertion must go red
 * on:
 * - an `internal: true` bridge network (the first design): nothing off the
 *   host is reachable, but Docker gives the host the bridge's first address and
 *   a service on the host that listens on every address answers the sidecar on
 *   it, sshd for one;
 * - the stack's default bridge network (a network with a gateway): the host
 *   canary and a public address are reached.
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
import { verdictJournalVolumeName, verdictVolumeName } from '../src/naming.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCANNING_TREE = resolve(here, '..', '..', 'adapters', 'scanning-storage');
const BUNDLE = join(SCANNING_TREE, 'verdict-host', 'generated', 'signed-request.cjs');
const IMAGE = process.env.VERDICT_NETWORK_TEST_IMAGE ?? 'ghost-platform:ci';

const SLUG = `vhn-${process.pid}` as Slug;
const UID = 30123 as TenantUid;
const PROJECT = `render-core-verdict-net-${process.pid}`;
const SERVICE = 'verdict-host';
// The `internal` control's own network; the rendered stack declares none.
const CONTROL_NETWORK = `vhn-control-${process.pid}`;
const VOLUMES = [verdictVolumeName(SLUG), verdictJournalVolumeName(SLUG)];
const KEY_MOUNT = '/run/verdict-verify.key';
const PUBLIC_ADDRESS = '1.1.1.1';
const DEFAULT_BRIDGE_GATEWAY = '172.17.0.1';
const NONE_LINE = "    network_mode: 'none'\n";
// The sidecar on an `internal: true` bridge of its own, which is the design the
// review refused: no route off the host, but the host holds the first address.
const INTERNAL_BRIDGE_LINES = '    networks:\n      - control\n';
const INTERNAL_BRIDGE_DECLARATION = `\nnetworks:\n  control:\n    name: '${CONTROL_NETWORK}'\n    internal: true\n`;

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
  /** Each network the container is on, with the address the container holds on
   * it (`IPAddress`). The `none` network has none. */
  readonly networks: Record<string, { IPAddress: string }>;
  /** The address Docker gave the host on each of those networks (the network's
   * gateway, from `docker network inspect`; the container's own endpoint leaves
   * it empty on an `internal` network). The `none` network has none. */
  readonly hostAddresses: Record<string, string>;
  /** The interfaces inside the sidecar that hold an address, with the addresses
   * (what Node's `os.networkInterfaces()` reports). */
  readonly interfaces: Record<string, string[]>;
  /** The routes inside the sidecar, as `/proc/net/route` lists them. */
  readonly routes: readonly string[];
  readonly logs: string;
}

/** A connect that got any answer from the address: accepted, or refused by a
 * host that is there (a closed port on a reachable host answers with a reset).
 * A timeout or "no route" is no answer: nothing is at the address. */
function answered(attempt: Attempt): boolean {
  return attempt.outcome === 'connected' || attempt.code === 'ECONNREFUSED';
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
    const inspect = (JSON.parse(docker('inspect', container)) as Record<string, unknown>[])[0];
    const networks = (inspect.NetworkSettings as { Networks: Run['networks'] }).Networks;
    const interfaces = JSON.parse(
      docker(
        'exec',
        container,
        'node',
        '-e',
        'console.log(JSON.stringify(Object.fromEntries(Object.entries(require("node:os").networkInterfaces()).map(([name, list]) => [name, list.map((entry) => entry.address)]))))'
      ).trim()
    ) as Run['interfaces'];
    const hostAddresses = Object.fromEntries(
      Object.keys(networks).map((name) => {
        const gateway = docker(
          'network',
          'inspect',
          name,
          '--format',
          '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
        ).trim();
        // Docker 29 prints "invalid IP" for a gateway a network does not have.
        return [name, gateway === 'invalid IP' ? '' : gateway];
      })
    );
    const routes = docker('exec', container, 'cat', '/proc/net/route').trim().split('\n').slice(1);
    // The host's own address on a network the sidecar is on, where Docker gave
    // it one: the host canary listens on every address, as sshd would.
    const hostAddressList = Object.values(hostAddresses).filter((address) => address !== '');
    const probe = docker(
      'exec',
      container,
      'node',
      '-e',
      PROBE,
      JSON.stringify([
        ['host.docker.internal', canaryPort],
        ...hostAddressList.map((address) => [address, canaryPort]),
        // The default bridge's gateway: Linux's host-gateway address.
        [DEFAULT_BRIDGE_GATEWAY, canaryPort],
        [PUBLIC_ADDRESS, 443],
      ])
    );
    // Docker Desktop forwards a published-to-host connect through a proxy, so
    // the canary's own accept can lag the probe's `connect` by a moment.
    await new Promise((done) => setTimeout(done, 2000));
    return {
      attempts: JSON.parse(probe.trim()) as Attempt[],
      canaryConnections,
      inspect,
      networks,
      hostAddresses,
      interfaces,
      routes,
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
    spawnSync('docker', ['network', 'rm', CONTROL_NETWORK], { stdio: 'ignore' });
    await new Promise<void>((done) => canary.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The control's own assertion: no outbound connect got any answer, and nothing
 * but loopback is inside the sidecar. */
function assertOutboundDenied(run: Run): void {
  const reached = run.attempts.filter((attempt) => attempt.outcome === 'connected');
  expect(reached, 'outbound connects that succeeded').toEqual([]);
  expect(run.canaryConnections, 'connections the host-side canary saw').toBe(0);
  const answers = run.attempts.filter(answered);
  expect(answers, 'addresses that answered, even with a refusal').toEqual([]);
  assertNoHostAddress(run);
}

/** The host has no address the sidecar can reach. `internal` removes the route
 * off the host, but Docker still gives the host the bridge's first address as
 * the gateway, which answers (even with a refusal) for any service on the host
 * that listens on every address, sshd for one. With `network_mode: none` the
 * container is on no network: no gateway, no address, no route, and loopback
 * is the only interface. */
function assertNoHostAddress(run: Run): void {
  expect(Object.keys(run.networks), 'the networks the sidecar is on').toEqual(['none']);
  for (const address of Object.values(run.hostAddresses)) {
    expect(address, 'an address Docker gave the host on the network').toBe('');
  }
  for (const entry of Object.values(run.networks)) {
    expect(entry.IPAddress, 'an address the sidecar holds on a network').toBe('');
  }
  expect(Object.keys(run.interfaces), 'interfaces with an address inside the sidecar').toEqual([
    'lo',
  ]);
  expect(run.routes, 'routes inside the sidecar').toEqual([]);
}

describe.skipIf(!canRun)(
  'LIVE — the rendered verdict host end has no network, so no route off the host and no host address',
  () => {
    const rendered = renderComposeStack(STACK);
    // Sabotage variants of the rendered file: each replaces the one network line.
    const internalBridgeText = `${rendered.replace(NONE_LINE, INTERNAL_BRIDGE_LINES)}${INTERNAL_BRIDGE_DECLARATION}`;
    const defaultNetworkText = rendered.replace(NONE_LINE, '');
    let denied: Run;
    let internalBridge: Run;
    let routed: Run;

    beforeAll(async () => {
      denied = await runSidecar(rendered);
      // One container at a time: each starts after the one before is removed.
      internalBridge = await runSidecar(internalBridgeText);
      routed = await runSidecar(defaultNetworkText);
    }, 450_000);

    afterAll(() => {
      for (const volume of VOLUMES)
        spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      spawnSync('docker', ['network', 'rm', CONTROL_NETWORK], { stdio: 'ignore' });
    });

    it('is rendered with no network, and each control differs by that line alone', () => {
      expect(rendered).toContain(NONE_LINE);
      expect(rendered).not.toContain('networks:');
      expect(internalBridgeText).not.toContain(NONE_LINE);
      expect(defaultNetworkText).toBe(rendered.replace(NONE_LINE, ''));
      expect(defaultNetworkText).not.toContain('network_mode');
    });

    it('runs the real host end with the rendered network mode, and only that', () => {
      expect(denied.logs).toContain('VERDICT_HOST_READY');
      expect((denied.inspect.HostConfig as { NetworkMode: string }).NetworkMode).toBe('none');
      assertNoHostAddress(denied);
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

    it('an outbound connect from inside it gets no answer: not from the host-gateway address, the default bridge gateway or a public address', () => {
      expect(denied.attempts).toHaveLength(3);
      assertOutboundDenied(denied);
    });

    it('CONTROL — the same stack on an internal bridge has the host on the network, so the host-address assertion goes red on it', () => {
      // `internal` is on, so nothing off the host is reachable...
      const offHost = internalBridge.attempts.find((attempt) =>
        attempt.target.startsWith(PUBLIC_ADDRESS)
      );
      expect(offHost?.outcome).toBe('error');
      expect(internalBridge.canaryConnections).toBe(0);
      // ...but Docker has given the host an address on the bridge, and it answers.
      const [hostAddress] = Object.values(internalBridge.hostAddresses);
      expect(hostAddress).not.toBe('');
      const atHost = internalBridge.attempts.find(
        (attempt) => attempt.target.split(':')[0] === hostAddress
      );
      expect(atHost && answered(atHost), JSON.stringify(internalBridge.attempts)).toBe(true);
      // RED: the assertions the rendered stack passes fail on the variant.
      expect(() => assertNoHostAddress(internalBridge)).toThrow();
      expect(() => assertOutboundDenied(internalBridge)).toThrow();
    });

    it('CONTROL — the same stack on a network with a gateway reaches the canary, so the refusal assertion goes red on it', () => {
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
