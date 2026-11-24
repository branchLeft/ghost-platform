/**
 * The blog as a tenant on the tenant ring: app-t1 (10.20.1.201) and db-t1
 * (10.20.1.200). `test/blog-tenant-ring/blog.descriptor.json` is its
 * descriptor; `test/tenant-zero/` stays the record of the 5.0.0 estate on
 * app1 and db1, and its goldens are not touched here.
 *
 * What is carried over unchanged: the slug, the site URL, the media bucket,
 * the mail transport and identity (the mail provider move is ISSUE 4336), and
 * the backup placeholder. What changes: the image pin, the app and database
 * addresses, and the uid and ports, which must not collide with the demo
 * slots already on app-t1 (the demo tenant holds uid 30001 and ports 8101 to
 * 8103 there).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TenantStackDescriptor } from '../src/descriptor.js';
import { render, type Artefact } from '../src/render.js';
import { validateTenantStack, type ZoneConfig } from '../src/validate.js';
import { TEST_ZONES } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = <T>(...parts: string[]): T =>
  JSON.parse(readFileSync(join(here, ...parts), 'utf-8')) as T;

const REPO = 'branchLeft/ghost-tenant-blog';
const ZONES: ZoneConfig = TEST_ZONES;
const APP_T1 = '10.20.1.201';
const DB_T1 = '10.20.1.200';

/** The old estate's addresses (app1 and db1), which no tenant-ring artefact may carry. */
const OLD_ESTATE_ADDRESSES: readonly RegExp[] = [/10\.20\.1\.100(?!\d)/, /10\.20\.1\.20(?!\d)/];

const loadBlog = (): TenantStackDescriptor =>
  readJson<TenantStackDescriptor>('blog-tenant-ring', 'blog.descriptor.json');
const loadDemo = (): TenantStackDescriptor =>
  readJson<TenantStackDescriptor>('demo-tenant', 'demo-tenant.descriptor.json');
const loadEstate = (): TenantStackDescriptor =>
  readJson<TenantStackDescriptor>('tenant-zero', 'blog.descriptor.json');

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

/** The uid and the three ports a descriptor claims, which must be unique on one app host. */
function allocations(d: TenantStackDescriptor): string[] {
  return [`uid:${d.uid}`, `port:${d.ports.a}`, `port:${d.ports.b}`, `port:${d.ports.health}`];
}

function collisions(a: TenantStackDescriptor, b: TenantStackDescriptor): string[] {
  const other = new Set(allocations(b));
  return allocations(a).filter((claim) => other.has(claim));
}

function withField<T extends object>(base: T, path: string, value: unknown): T {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const keys = path.split('.');
  let cursor = copy;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[keys.at(-1) as string] = value;
  return copy as T;
}

describe('blog on the tenant ring: the descriptor is accepted and renders', () => {
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

  it('pins the tenant-ring image, and only that one', () => {
    expect(content(artefacts(), 'image.env')).toContain(loadBlog().image);
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

  it('keeps the mail transport and identity exactly as today (ISSUE 4336 moves them)', () => {
    const blog = loadBlog();
    const estate = loadEstate();
    expect(blog.transport).toEqual(estate.transport);
    expect(blog.mail).toEqual(estate.mail);
  });
});

describe('blog on the tenant ring: its allocations do not collide with the demo slots', () => {
  it('shares app-t1 with the demo tenant, and holds its own uid and ports there', () => {
    const blog = loadBlog();
    const demo = loadDemo();
    expect(blog.appHostIp).toBe(demo.appHostIp);
    expect(collisions(blog, demo)).toEqual([]);
  });

  it('is refused the estate values, so the old addresses cannot come back unnoticed', () => {
    const sabotaged = withField(loadBlog(), 'appHostIp', '10.20.1.100');
    expect(estateAddressesIn(artefacts(sabotaged))).not.toEqual([]);
  });

  it('is refused a uid or port the demo tenant already holds (control)', () => {
    const sabotaged = withField(withField(loadBlog(), 'uid', 30001), 'ports.a', 8101);
    expect(collisions(sabotaged, loadDemo())).toEqual(['uid:30001', 'port:8101']);
  });
});
