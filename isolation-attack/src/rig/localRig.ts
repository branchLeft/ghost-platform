// The local rig: two disposable Ghost tenants behind one Caddy edge on a shared
// parent domain, built from the repository's own image, the proof origin
// image, the demo edge's upload refusal and render-core's policy. Everything is
// named with a run prefix and removed at the end, and a killed run's leftovers
// are swept at the next start. `*.localhost` names resolve to loopback in a
// browser, so no hosts file and no DNS are involved.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GhostAdmin } from '../ghostAdmin.ts';
import { http } from '../http.ts';
import type { ImageRecord } from '../model.ts';
import type { Credentials } from '../target.ts';
import type { TenantHandle } from '../world.ts';
import { containerImageId, docker, inspectImage, pinnedBases, removeAll } from './docker.ts';
import { GUARD_MOUNT, renderCaddyfile, type EdgeTenant } from './edge.ts';
import { derivePolicy, type RenderedPolicy } from './policy.ts';

const run = promisify(execFile);

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const ROOT_DOMAIN = 'pp.localhost';
export const SHARED_DOMAIN = `sites.${ROOT_DOMAIN}`;
export const PORTAL_HOST = `portal.${ROOT_DOMAIN}`;

const PREFIX = 'isoattack-';

export type EdgeMode = 'full' | 'no-csp' | 'no-upload-guard' | 'origin-spoof';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

function credentials(label: string): Credentials {
  return {
    email: `attack-suite-${label}@example.test`,
    password: `Aa1-${randomBytes(12).toString('hex')}`,
  };
}

async function waitFor(
  what: string,
  seconds: number,
  probe: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await probe().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`${what} was not ready within ${seconds}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The environment the platform image runs under in every live gate (see csp/gate/lib.sh). */
function ghostArgs(
  name: string,
  network: string,
  origin: string,
  edgeOrigin: string,
  image: string
): string[] {
  const storage = (feature: string, wraps: string): string[] => [
    '-e',
    `storage__${feature}__adapter=ScanningStorageAdapter`,
    '-e',
    `storage__${feature}__wraps=${wraps}`,
    '-e',
    `storage__${feature}__quarantinePath=/var/lib/ghost/content/quarantine`,
    '-e',
    `storage__${feature}__verdictSource=in-process-fake`,
  ];
  return [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    '-e',
    `url=${origin}`,
    '-e',
    'database__client=sqlite3',
    '-e',
    'database__connection__filename=/var/lib/ghost/content/data/ghost-isolation-attack.db',
    '-e',
    'privacy__useUpdateCheck=false',
    '-e',
    'BRANCHLEFT_ALLOW_LOCAL_STORAGE=true',
    ...storage('images', 'LocalImagesStorage'),
    ...storage('media', 'LocalMediaStorage'),
    ...storage('files', 'LocalFilesStorage'),
    '-e',
    'logging__transports=["stdout"]',
    '-e',
    `portal__url=${edgeOrigin}/bl-assets/portal.min.js`,
    '-e',
    `sodoSearch__url=${edgeOrigin}/bl-assets/sodo-search.min.js`,
    '-e',
    `sodoSearch__styles=${edgeOrigin}/bl-assets/sodo-search.min.css`,
    image,
  ];
}

export interface RigImages {
  readonly ghost: string;
  readonly edge: string;
}

export class LocalRig {
  readonly port: number;
  readonly a: TenantHandle;
  readonly b: TenantHandle;
  private readonly names: { network: string; ghostA: string; ghostB: string; edge: string };
  private readonly dir: string;
  private readonly images: RigImages;
  private guard = '';
  private policies: { a: RenderedPolicy; b: RenderedPolicy } | null = null;
  private mode: EdgeMode | null = null;
  private readonly credentials: { a: Credentials; b: Credentials };

  private constructor(
    port: number,
    dir: string,
    images: RigImages,
    names: LocalRig['names'],
    creds: LocalRig['credentials']
  ) {
    this.port = port;
    this.dir = dir;
    this.images = images;
    this.names = names;
    this.credentials = creds;
    const handle = (label: string): TenantHandle => {
      const host = `${label}.${SHARED_DOMAIN}`;
      const origin = `http://${host}:${port}`;
      return { host, origin, secure: false, admin: new GhostAdmin(origin) };
    };
    this.a = handle('a');
    this.b = handle('b');
  }

  get edgeMode(): EdgeMode | null {
    return this.mode;
  }

  static async start(log: (line: string) => void): Promise<LocalRig> {
    await removeAll(PREFIX);
    const ghostImage = process.env['ATTACK_GHOST_IMAGE'] ?? 'isolation-attack-ghost:local';
    const edgeImage = 'isolation-attack-edge:local';
    if (process.env['ATTACK_GHOST_IMAGE'] === undefined) {
      log('building the platform image (layers cached from earlier builds are reused)');
      await docker(['build', '-q', '-t', ghostImage, '.'], {
        cwd: REPO_ROOT,
        timeoutMs: 1_800_000,
      });
    }
    log('building the edge image');
    await docker(['build', '-q', '-f', 'csp/proof/Dockerfile', '-t', edgeImage, '.'], {
      cwd: REPO_ROOT,
      timeoutMs: 600_000,
    });

    const id = `${process.pid}`;
    const names = {
      network: `${PREFIX}net-${id}`,
      ghostA: `${PREFIX}ghost-a-${id}`,
      ghostB: `${PREFIX}ghost-b-${id}`,
      edge: `${PREFIX}edge-${id}`,
    };
    const dir = await mkdtemp(join(tmpdir(), PREFIX));
    const rig = new LocalRig(await freePort(), dir, { ghost: ghostImage, edge: edgeImage }, names, {
      a: credentials('a'),
      b: credentials('b'),
    });
    try {
      await rig.boot(log);
    } catch (error) {
      await rig.stop().catch(() => undefined);
      throw error;
    }
    return rig;
  }

  private async boot(log: (line: string) => void): Promise<void> {
    const { stdout } = await run(
      'python3',
      ['demo-host/provision/render_demo_site.py', '--print-upload-guard'],
      {
        cwd: REPO_ROOT,
      }
    );
    this.guard = stdout;

    await docker(['network', 'create', this.names.network]);
    const edgeOrigin = (t: TenantHandle) => t.origin;
    await docker(
      ghostArgs(
        this.names.ghostA,
        this.names.network,
        this.a.origin,
        edgeOrigin(this.a),
        this.images.ghost
      )
    );
    await docker(
      ghostArgs(
        this.names.ghostB,
        this.names.network,
        this.b.origin,
        edgeOrigin(this.b),
        this.images.ghost
      )
    );
    for (const name of [this.names.ghostA, this.names.ghostB]) {
      await waitFor(`Ghost ${name}`, 150, async () => {
        await docker(['exec', name, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:2368/']);
        return true;
      });
    }

    log("edge up with no content policy, to read each tenant's clean pages");
    await this.setMode('no-csp');

    const content: Record<'a' | 'b', { slug: string; tag: string; author: string }> = {
      a: await this.becomeOwner(this.a, this.credentials.a, 'Victim tenant'),
      b: await this.becomeOwner(this.b, this.credentials.b, 'Attacker tenant'),
    };
    const derive = (t: TenantHandle, c: { slug: string; tag: string; author: string }) =>
      derivePolicy(t.origin, ['/', `/${c.slug}/`, `/tag/${c.tag}/`, `/author/${c.author}/`]);
    this.policies = { a: await derive(this.a, content.a), b: await derive(this.b, content.b) };
    await this.setMode('full');
  }

  private async becomeOwner(
    tenant: TenantHandle,
    creds: Credentials,
    title: string
  ): Promise<{ slug: string; tag: string; author: string }> {
    await tenant.admin.setupOwner(creds, title);
    await tenant.admin.login(creds);
    const post = await tenant.admin.publishPlainPost(`${title} post`);
    return { slug: post.slug, tag: post.tag, author: post.author };
  }

  /** Replaces the edge container with one configured for the mode. */
  async setMode(mode: EdgeMode): Promise<void> {
    const policy = (p: RenderedPolicy | undefined): string | null =>
      mode === 'no-csp' || p === undefined ? null : p.value;
    const tenants: EdgeTenant[] = [
      {
        host: this.a.host,
        upstream: `${this.names.ghostA}:2368`,
        csp: policy(this.policies?.a),
        spoofOrigin: mode === 'origin-spoof' ? this.a.origin : null,
      },
      {
        host: this.b.host,
        upstream: `${this.names.ghostB}:2368`,
        csp: policy(this.policies?.b),
        spoofOrigin: null,
      },
    ];
    const caddyfile = join(this.dir, 'Caddyfile');
    const guard = join(this.dir, 'upload-guard.caddy');
    await writeFile(caddyfile, renderCaddyfile(tenants), { mode: 0o644 });
    await writeFile(guard, mode === 'no-upload-guard' ? '' : this.guard, { mode: 0o644 });
    await docker(['rm', '-f', this.names.edge]).catch(() => undefined);
    await docker([
      'run',
      '-d',
      '--name',
      this.names.edge,
      '--network',
      this.names.network,
      '-p',
      `127.0.0.1:${this.port}:8080`,
      '-v',
      `${caddyfile}:/etc/caddy/Caddyfile:ro`,
      '-v',
      `${guard}:${GUARD_MOUNT}:ro`,
      this.images.edge,
    ]);
    await waitFor('the edge', 60, async () => (await http(`${this.a.origin}/`)).status === 200);
    this.mode = mode;
  }

  /** The policy header each tenant is served, read from the wire, so a report cannot claim one the edge did not send. */
  async servedPolicy(tenant: TenantHandle): Promise<string | null> {
    const res = await http(`${tenant.origin}/`);
    const value = res.headers['content-security-policy'];
    return typeof value === 'string' ? value : null;
  }

  async imageRecords(): Promise<ImageRecord[]> {
    const read = async (
      role: string,
      reference: string,
      fromContainer?: string
    ): Promise<ImageRecord> => {
      const inspected = await inspectImage(reference);
      const running =
        fromContainer === undefined ? inspected.imageId : await containerImageId(fromContainer);
      return {
        role,
        reference,
        imageId: running,
        repoDigests: inspected.repoDigests,
        source: 'inspected',
      };
    };
    const pinned = async (role: string, dockerfile: string): Promise<ImageRecord[]> =>
      pinnedBases(await readFile(join(REPO_ROOT, dockerfile), 'utf-8')).map((reference) => ({
        role,
        reference,
        imageId: null,
        repoDigests: [reference],
        source: 'pinned' as const,
      }));
    return [
      await read('Tenant Ghost (platform image)', this.images.ghost, this.names.ghostA),
      ...(await pinned('Tenant Ghost base image', 'Dockerfile')),
      await read('Edge (proof origin image)', this.images.edge, this.names.edge),
      ...(await pinned('Edge base image', 'csp/proof/Dockerfile')),
    ];
  }

  async stop(): Promise<void> {
    await removeAll(PREFIX).catch(() => undefined);
    await rm(this.dir, { recursive: true, force: true });
  }
}
