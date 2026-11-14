/**
 * The first PublicPress tenant slot on the tenant ring's app host: a
 * branchLeft-owned demo site, not a customer. `test/demo-tenant/
 * demo-tenant.descriptor.json` is its descriptor; the seven artefacts it
 * renders are pinned to `test/golden/demo-tenant.*`.
 *
 * What is fixed by the owner: the slug, the image digest, mail off, the
 * database on the tenant database host. What is allocated here and is only
 * checked against the host at placement: the uid, the three ports and the
 * app host's private address (`APP_HOST_IP` below, which the host's own
 * address plan has not registered yet). A change to any of them is a
 * deliberate edit of the descriptor, the goldens and this file together.
 *
 * Media is object storage, not local. `validateTenantStack` refuses
 * `media.kind: 'local'` for kind `tenant` (checked below), and the image's
 * entrypoint refuses local storage outside the demo ring. The bucket named
 * here is derived from the slug; nothing in this change creates it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FieldValidationError, validateSlug } from '../src/brand.js';
import type { TenantStackDescriptor } from '../src/descriptor.js';
import { mediaBucketName } from '../src/media.js';
import {
  composeUnitName,
  contentVolumeName,
  databaseAndUserName,
  imageEnvPath,
  secretsEnvPath,
  stackDirectory,
  validateSlugAvailability,
  type SlugClaimant,
} from '../src/naming.js';
import { render, type Artefact } from '../src/render.js';
import { TierMismatchError, validateTenantStack, type ZoneConfig } from '../src/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(here, ...parts), 'utf-8');

const SLUG = 'demo-tenant';
const IMAGE =
  'ghcr.io/branchleft/ghost-tenant@sha256:8c9f2dc488c03454609e6573674f10f27ca162a440ff3f5910eaab48bafd9f3d';
const DB_T1_ADDRESS = '10.20.1.200';
const APP_HOST_IP = '10.20.1.201';
const CLAIMANT: SlugClaimant = { kind: 'tenant', repo: 'branchLeft/ghost-tenant-demo-tenant' };

/** The platform's zones as the broker and the odask service name them; the caller's to supply in production. */
const ZONES: ZoneConfig = {
  demoZone: 'demo.trypublicpress.co.uk',
  platformZone: 'sites.publicpress.co.uk',
  ownedDomains: ['demo.trypublicpress.co.uk', 'publicpress.co.uk'],
  demoMailDomain: 'demo.trypublicpress.co.uk',
};

const ARTEFACTS = [
  'compose.yml',
  'secrets.env',
  'image.env',
  'provision.sh',
  'edge.json',
  'ghost-settings.json',
  'identity.json',
] as const;

function load(): TenantStackDescriptor {
  return JSON.parse(read('demo-tenant', 'demo-tenant.descriptor.json')) as TenantStackDescriptor;
}

/** A copy of the descriptor with one dotted path replaced. */
function mutate(path: string, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(load())) as Record<string, unknown>;
  const keys = path.split('.');
  let cursor = copy;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[keys.at(-1) as string] = value;
  return copy;
}

function rendered(descriptor: unknown = load()): readonly Artefact[] {
  return render(validateTenantStack(descriptor as TenantStackDescriptor, ZONES), ZONES);
}

function content(artefacts: readonly Artefact[], path: string): string {
  const found = artefacts.find((artefact) => artefact.path === path);
  if (found === undefined) throw new Error(`no artefact ${path}`);
  return found.content;
}

describe('the first PublicPress tenant descriptor', () => {
  it('validates as a tenant stack descriptor with no claimant: the name is in no register', () => {
    expect(() => validateTenantStack(load(), ZONES)).not.toThrow();
    expect(Object.keys(load())).not.toContain('ownerEmail');
    expect(JSON.stringify(load())).not.toMatch(/password|secret|apikey|token/i);
  });

  it('derives every name from the slug', () => {
    const d = load();
    expect(d.slug).toBe(SLUG);
    expect(d.siteUrl).toBe('https://demo-tenant.sites.publicpress.co.uk');
    expect(d.hostname).toEqual({ kind: 'ours', sub: SLUG, gated: false });
    expect(databaseAndUserName(d.slug)).toBe('ghost_demo_tenant');
    expect(stackDirectory(d.slug)).toBe('/opt/branchleft/demo-tenant');
    expect(composeUnitName(d.slug)).toBe('branchleft-compose@demo-tenant.service');
    expect(secretsEnvPath(d.slug)).toBe('/etc/branchleft/demo-tenant.env');
    expect(imageEnvPath(d.slug)).toBe('/etc/branchleft/demo-tenant.image.env');
    expect(contentVolumeName(d.slug)).toBe('ghost-demo-tenant-content');
    expect(mediaBucketName(d.slug)).toBe('branchleft-media-demo-tenant');
    expect(d.database).toEqual({
      kind: 'mysql',
      host: DB_T1_ADDRESS,
      port: 3306,
      name: 'ghost_demo_tenant',
      user: 'ghost_demo_tenant',
    });
    expect(d.appHostIp).toBe(APP_HOST_IP);
  });

  it('is pinned to the attested tenant image by digest', () => {
    expect(load().image).toBe(IMAGE);
    expect(content(rendered(), 'image.env')).toBe(`IMAGE=${IMAGE}\n`);
  });

  it('renders exactly the seven artefacts', () => {
    expect(rendered().map((artefact) => artefact.path)).toEqual([...ARTEFACTS]);
  });

  it.each(ARTEFACTS)('pins %s to a committed golden', (path) => {
    expect(content(rendered(), path)).toBe(read('golden', `demo-tenant.${path}`));
  });
});

describe('mail is off', () => {
  it('renders no mail transport, no bulk-email key, no spool network and no mail secret', () => {
    const artefacts = rendered();
    const compose = content(artefacts, 'compose.yml');
    expect(load().mail.enabled).toBe(false);
    expect(compose).not.toMatch(/mail__transport|mail__options|bulkEmail/);
    expect(compose).not.toMatch(/mail-spool|spool/i);
    expect(content(artefacts, 'secrets.env')).toBe(
      [
        '# Secrets for the demo-tenant Ghost stack, at /etc/branchleft/demo-tenant.env.',
        '# Root-owned, mode 0600. Written by an operator; no automated path may',
        '# rewrite this file. render() names the keys this tenant needs below —',
        '# it never has a value to put here.',
        'GHOST_DB_PASSWORD=',
        'GHOST_S3_ACCESS_KEY_ID=',
        'GHOST_S3_SECRET_ACCESS_KEY=',
        'GHOST_OWNER_EMAIL=',
        '',
      ].join('\n')
    );
  });

  it('control: the same descriptor with mail enabled does render the mail keys, so the check above can fail', () => {
    const on = {
      ...load(),
      mail: { ...load().mail, enabled: true, ceiling: 100, estateCeiling: 100 },
    };
    expect(content(rendered(on), 'compose.yml')).toMatch(/bulkEmail/);
  });
});

describe('what the descriptor cannot say', () => {
  it('refuses local media for a tenant: media is object storage', () => {
    const local = {
      kind: 'local',
      path: '/data/demo-tenant/content',
      resize: false,
      srcsets: false,
    };
    expect(() => rendered(mutate('media', local))).toThrow(TierMismatchError);
  });

  it('refuses another tenant’s bucket', () => {
    expect(() => rendered(mutate('media.bucket', 'branchleft-media-blog'))).toThrow(
      FieldValidationError
    );
  });

  it('refuses a database that is not the one this slug derives', () => {
    expect(() => rendered(mutate('database.name', 'ghost_blog'))).toThrow(FieldValidationError);
  });

  it('refuses a site address outside the platform zone', () => {
    expect(() => rendered(mutate('siteUrl', 'https://demo-tenant.example.test'))).toThrow();
  });

  it.each([
    'website',
    'edge',
    'db',
    'monitoring',
    'nextcloud1',
    'mail-spool',
    'publicpress-website',
    'blog',
  ])('refuses the registered name %s to this tenant', (name) => {
    expect(() => validateSlugAvailability(validateSlug(name), CLAIMANT)).toThrow(
      FieldValidationError
    );
  });

  it('control: the slug itself is accepted by the same check', () => {
    expect(() => validateSlugAvailability(validateSlug(SLUG), CLAIMANT)).not.toThrow();
  });
});
