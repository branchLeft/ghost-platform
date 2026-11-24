/**
 * The blog as a tenant on the tenant ring: app-t1 (10.20.1.201) and db-t1
 * (10.20.1.200). `test/blog-tenant-ring/blog.descriptor.json` is its
 * descriptor; `test/tenant-zero/` stays the record of the 5.0.0 estate on
 * app1 and db1, and its goldens are not touched here.
 *
 * The descriptor carries no attested image yet. Its image is an unset
 * placeholder, which validation refuses, so the committed descriptor cannot be
 * placed until the blog's full attested digest is read and set. The render
 * checks below use a fixture digest that is never placed and is not the demo's.
 *
 * Reserved uids and ports are read from the demo host's own sources, not
 * copied here: the register and router in `demo-host/provision/`, and the slot
 * port golden. A blog allocation that lands on any of them is refused.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FieldValidationError } from '../src/brand.js';
import type { TenantStackDescriptor } from '../src/descriptor.js';
import { render, type Artefact } from '../src/render.js';
import { validateTenantStack, type ZoneConfig } from '../src/validate.js';
import { TEST_ZONES } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(here, ...parts), 'utf-8');
const readJson = <T>(...parts: string[]): T => JSON.parse(read(...parts)) as T;

const REPO = 'branchLeft/ghost-tenant-blog';
const ZONES: ZoneConfig = TEST_ZONES;
const APP_T1 = '10.20.1.201';
const DB_T1 = '10.20.1.200';
/** The blog's attested image: the digest its slot deploys (ISSUE 4135) and the boot test ran. */
const BLOG_IMAGE_DIGEST = '6209d10360e108d143e2318350fda42ee44453f96108b1e8eaf572c47129db9e';
const UNSET_IMAGE = 'ghcr.io/branchleft/ghost-tenant@sha256:BLOG_TENANT_RING_DIGEST_UNSET';

/** The old estate's addresses (app1 and db1), which no tenant-ring artefact may carry. */
const OLD_ESTATE_ADDRESSES: readonly RegExp[] = [/10\.20\.1\.100(?!\d)/, /10\.20\.1\.20(?!\d)/];

// ---------------------------------------------------------------------------
// Reserved uids and ports, read from the demo host's sources.

const DEMO_HOST = ['..', '..', 'demo-host', 'provision'];

/** The integer assigned to `name` at module level in a Python source, e.g. `ROUTER_UID = 30008`. */
function pyConstant(source: string, file: string, name: string): number {
  const match = new RegExp(`^${name}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(source);
  if (match === null) throw new Error(`${file} does not assign ${name} an integer`);
  return Number(match[1]);
}

interface DemoHostSources {
  readonly uidBase: number;
  readonly slotCount: number;
  readonly routerUid: number;
  readonly tenantUidMin: number;
  readonly tenantUidMax: number;
  readonly appPortBase: number;
  readonly healthPortBase: number;
  readonly sidecarRouterUid: number;
  readonly golden: {
    readonly slots: readonly {
      readonly slot: string;
      readonly a: number;
      readonly b: number;
      readonly health: number;
    }[];
    readonly knownExporterPorts: readonly number[];
  };
}

function demoHostSources(): DemoHostSources {
  const claims = read(...DEMO_HOST, 'demo_uid_claims.py');
  const router = read(...DEMO_HOST, 'health_router.py');
  const sidecar = read(...DEMO_HOST, 'demo_sidecar.py');
  const slotCount = /SLOT_NAMES[^=]*=\s*tuple\(str\(n\) for n in range\((\d+)\)\)/.exec(claims);
  if (slotCount === null) throw new Error('demo_uid_claims.py does not define SLOT_NAMES by range');
  return {
    uidBase: pyConstant(claims, 'demo_uid_claims.py', 'UID_BASE'),
    slotCount: Number(slotCount[1]),
    routerUid: pyConstant(claims, 'demo_uid_claims.py', 'ROUTER_UID'),
    tenantUidMin: pyConstant(claims, 'demo_uid_claims.py', 'TENANT_UID_MIN'),
    tenantUidMax: pyConstant(claims, 'demo_uid_claims.py', 'TENANT_UID_MAX'),
    appPortBase: pyConstant(router, 'health_router.py', 'APP_PORT_BASE'),
    healthPortBase: pyConstant(router, 'health_router.py', 'HEALTH_PORT_BASE'),
    sidecarRouterUid: pyConstant(sidecar, 'demo_sidecar.py', 'ROUTER_UID'),
    golden: readJson(...DEMO_HOST, 'slot-ports.golden.json'),
  };
}

const SOURCES = demoHostSources();

/** Every uid the demo host has claimed or the tenant register must never hand out. */
function reservedUids(): Set<number> {
  const uids = new Set<number>();
  for (let slot = 0; slot < SOURCES.slotCount; slot += 1) uids.add(SOURCES.uidBase + slot);
  uids.add(SOURCES.routerUid);
  return uids;
}

/** Every app and health port the demo host allocates, and the known exporter ports. */
function reservedPorts(): Set<number> {
  const ports = new Set<number>(SOURCES.golden.knownExporterPorts);
  for (const slot of SOURCES.golden.slots) {
    ports.add(slot.a);
    ports.add(slot.b);
    ports.add(slot.health);
  }
  return ports;
}

const loadBlog = (): TenantStackDescriptor =>
  readJson<TenantStackDescriptor>('blog-tenant-ring', 'blog.descriptor.json');
const loadDemo = (): TenantStackDescriptor =>
  readJson<TenantStackDescriptor>('demo-tenant', 'demo-tenant.descriptor.json');

function accepted(descriptor: TenantStackDescriptor): TenantStackDescriptor {
  return validateTenantStack(descriptor, ZONES, { claimantRepo: REPO });
}

function artefacts(descriptor: TenantStackDescriptor = loadBlog()): readonly Artefact[] {
  return render(accepted(descriptor), ZONES);
}

function content(rendered: readonly Artefact[], path: string): string {
  const found = rendered.find((artefact) => artefact.path === path);
  if (found === undefined) throw new Error(`no artefact ${path}`);
  return found.content;
}

/** Every old-estate address that appears in any rendered artefact. */
function estateAddressesIn(rendered: readonly Artefact[]): string[] {
  return rendered.flatMap((artefact) =>
    OLD_ESTATE_ADDRESSES.filter((pattern) => pattern.test(artefact.content)).map(
      (pattern) => `${artefact.path}: ${pattern.source}`
    )
  );
}

/** Every uid and port a descriptor claims that the demo host reserves. */
function reservedClaims(d: TenantStackDescriptor): string[] {
  const uids = reservedUids();
  const ports = reservedPorts();
  const claims: string[] = [];
  if (uids.has(d.uid)) claims.push(`uid:${d.uid}`);
  for (const port of [d.ports.a, d.ports.b, d.ports.health]) {
    if (ports.has(port)) claims.push(`port:${port}`);
  }
  return claims;
}

function withField<T extends object>(base: T, path: string, value: unknown): T {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const keys = path.split('.');
  let cursor = copy;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[keys.at(-1) as string] = value;
  return copy as T;
}

describe('demo host sources: the reserved set is read, not assumed', () => {
  it('reads the tenant uid range the demo register enforces, and places the blog inside it', () => {
    expect(SOURCES.tenantUidMin).toBe(30000);
    expect(SOURCES.tenantUidMax).toBe(30999);
    const uid = loadBlog().uid;
    expect(uid).toBeGreaterThanOrEqual(SOURCES.tenantUidMin);
    expect(uid).toBeLessThanOrEqual(SOURCES.tenantUidMax);
  });

  it('agrees on the router uid across the register and the sidecar', () => {
    expect(SOURCES.routerUid).toBe(SOURCES.sidecarRouterUid);
  });

  it('agrees the golden slot ports with the router constants, so the reserved set is complete', () => {
    for (const slot of SOURCES.golden.slots) {
      const n = Number(slot.slot);
      expect(slot.a).toBe(SOURCES.appPortBase + 2 * n);
      expect(slot.b).toBe(SOURCES.appPortBase + 2 * n + 1);
      expect(slot.health).toBe(SOURCES.healthPortBase + n);
    }
  });
});

describe("blog on the tenant ring: the image is the blog's attested digest", () => {
  it("pins the blog's attested digest, not the demo tenant's", () => {
    const image = loadBlog().image;
    expect(image).toBe(`ghcr.io/branchleft/ghost-tenant@sha256:${BLOG_IMAGE_DIGEST}`);
    expect(image).not.toBe(loadDemo().image);
  });

  it('validates once the attested digest is set', () => {
    expect(() => accepted(loadBlog())).not.toThrow();
  });

  it('still refuses the unset placeholder, so an unpinned descriptor cannot be placed', () => {
    const unset = { ...loadBlog(), image: UNSET_IMAGE } as TenantStackDescriptor;
    expect(() => accepted(unset)).toThrow(FieldValidationError);
  });
});

describe('blog on the tenant ring: the descriptor renders', () => {
  it('validates for its own repository with no secret and no owner address', () => {
    const d = loadBlog();
    expect(() => accepted(d)).not.toThrow();
    expect(Object.keys(d)).not.toContain('ownerEmail');
    expect(JSON.stringify(d)).not.toMatch(/password|secret|apikey|token/i);
  });

  it('renders the seven artefacts', () => {
    expect(artefacts().map((artefact) => artefact.path)).toEqual([
      'compose.yml',
      'secrets.env',
      'image.env',
      'provision.sh',
      'edge.json',
      'ghost-settings.json',
      'identity.json',
    ]);
  });

  it('places the stack on app-t1 and its database on db-t1', () => {
    const compose = content(artefacts(), 'compose.yml');
    expect(compose).toContain(APP_T1);
    expect(compose).toContain(DB_T1);
    expect(estateAddressesIn(artefacts())).toEqual([]);
  });

  it('pins the image the descriptor carries, and no other', () => {
    const d = loadBlog();
    expect(content(artefacts(), 'image.env')).toContain(d.image);
  });

  it('names every secret and gives none a value', () => {
    const secrets = content(artefacts(), 'secrets.env')
      .split('\n')
      .filter((line) => /^[A-Z]/.test(line));
    expect(secrets).toEqual([
      'GHOST_DB_PASSWORD=',
      'GHOST_S3_ACCESS_KEY_ID=',
      'GHOST_S3_SECRET_ACCESS_KEY=',
      'GHOST_MAIL_PASSWORD=',
      'GHOST_BULK_EMAIL_API_KEY=',
      'GHOST_OWNER_EMAIL=',
    ]);
  });

  it('keeps the mail transport and identity as the estate has them (ISSUE 4336 moves them)', () => {
    const estate = readJson<TenantStackDescriptor>('tenant-zero', 'blog.descriptor.json');
    expect(loadBlog().transport).toEqual(estate.transport);
    expect(loadBlog().mail).toEqual(estate.mail);
  });
});

describe("blog on the tenant ring: its uid and ports are not the demo host's", () => {
  it('shares app-t1 with the demo tenant and reserves nothing the demo host holds', () => {
    const blog = loadBlog();
    expect(blog.appHostIp).toBe(loadDemo().appHostIp);
    expect(reservedClaims(blog)).toEqual([]);
  });

  it('refuses the router uid the demo host reserves (control)', () => {
    const sabotaged = withField(loadBlog(), 'uid', SOURCES.routerUid);
    expect(reservedClaims(sabotaged)).toEqual([`uid:${SOURCES.routerUid}`]);
  });

  it('refuses an app or health port the demo slots hold (control)', () => {
    const sabotaged = withField(loadBlog(), 'ports.a', SOURCES.golden.slots[0].a);
    expect(reservedClaims(sabotaged)).toEqual([`port:${SOURCES.golden.slots[0].a}`]);
  });

  it('refuses a port the demo host reserves for an exporter (control)', () => {
    const exporter = SOURCES.golden.knownExporterPorts[0];
    const sabotaged = withField(loadBlog(), 'ports.health', exporter);
    expect(reservedClaims(sabotaged)).toEqual([`port:${exporter}`]);
  });

  it('refuses the estate values, so the old addresses cannot come back unnoticed (control)', () => {
    const sabotaged = withField(loadBlog(), 'appHostIp', '10.20.1.100');
    expect(estateAddressesIn(artefacts(sabotaged))).not.toEqual([]);
  });
});
