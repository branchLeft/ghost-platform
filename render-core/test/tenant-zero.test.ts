/**
 * Tenant zero's descriptor: the live blog as a document the render core
 * accepts, the seven artefacts it renders, and every difference from what
 * the running configuration was rendered from. See tenant-zero.md.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FieldValidationError } from '../src/brand.js';
import type { TenantStackDescriptor } from '../src/descriptor.js';
import { mediaPublicBaseUrl } from '../src/media.js';
import {
  composeUnitName,
  databaseAndUserName,
  imageEnvPath,
  secretsEnvPath,
  stackDirectory,
} from '../src/naming.js';
import { render, type Artefact } from '../src/render.js';
import { InvariantViolationError, validateTenantStack, type ZoneConfig } from '../src/validate.js';
import { TEST_ZONES } from './fixtures.js';
import {
  differences,
  flattenEmitted,
  flattenEnvFile,
  flattenJson,
  judgedTwice,
  stale,
  unreviewed,
  type Difference,
  type ReviewedEntry,
} from './tenant-zero/diff.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(here, ...parts), 'utf-8');
const readJson = <T>(...parts: string[]): T => JSON.parse(read(...parts)) as T;

const REPO = 'branchLeft/ghost-tenant-blog';

/**
 * The fixture zones, with tenant zero's own domain outside every domain the
 * platform owns. The platform's real zones are the caller's to supply, and
 * are a live-step confirmation: see tenant-zero.md#what-this-does-not-prove.
 */
const ZONES: ZoneConfig = TEST_ZONES;

function loadDescriptor(): TenantStackDescriptor {
  return readJson<TenantStackDescriptor>('tenant-zero', 'blog.descriptor.json');
}

function accepted(descriptor: unknown): TenantStackDescriptor {
  return validateTenantStack(descriptor as TenantStackDescriptor, ZONES, { claimantRepo: REPO });
}

function renderedArtefacts(descriptor: unknown = loadDescriptor()): readonly Artefact[] {
  return render(accepted(descriptor), ZONES);
}

function content(artefacts: readonly Artefact[], path: string): string {
  const found = artefacts.find((artefact) => artefact.path === path);
  if (found === undefined) throw new Error(`no artefact ${path}`);
  return found.content;
}

/** A copy of the descriptor with one dotted path replaced (or removed, when `value` is undefined). */
function mutate(path: string, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(loadDescriptor())) as Record<string, unknown>;
  const keys = path.split('.');
  let cursor = copy;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  const last = keys.at(-1) as string;
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
  return copy;
}

describe('tenant zero descriptor: accepted by the render core', () => {
  it('validates as a tenant stack descriptor for its own repository, with no secret and no owner address', () => {
    const descriptor = loadDescriptor();
    expect(() => accepted(descriptor)).not.toThrow();
    expect(Object.keys(descriptor)).not.toContain('ownerEmail');
    expect(JSON.stringify(descriptor)).not.toMatch(/password|secret|apikey|token/i);
  });

  it('renders exactly the seven artefacts', () => {
    expect(renderedArtefacts().map((artefact) => artefact.path)).toEqual([
      'compose.yml',
      'secrets.env',
      'image.env',
      'provision.sh',
      'edge.json',
      'ghost-settings.json',
      'identity.json',
    ]);
  });

  it.each([
    'compose.yml',
    'secrets.env',
    'image.env',
    'provision.sh',
    'edge.json',
    'ghost-settings.json',
    'identity.json',
  ])('pins %s to a committed golden', (path) => {
    expect(content(renderedArtefacts(), path)).toBe(read('golden', `tenant-zero.${path}`));
  });

  it('expresses the live stack configuration: every plain value in Pulumi.blog.yaml is in the descriptor', () => {
    const stack = readJson<Record<string, string | number>>(
      'tenant-zero',
      'tenant-5.0.0',
      'stack-config.json'
    );
    const d = loadDescriptor();
    expect({
      slug: d.slug,
      siteUrl: d.siteUrl,
      uid: d.uid,
      hostPort: d.ports.a,
      appHostPrivateIp: d.appHostIp,
      imageRef: d.image,
      databaseHost: d.database.kind === 'mysql' ? d.database.host : null,
      mediaEndpoint: d.media.kind === 's3' ? d.media.endpoint : null,
      mediaRegion: d.media.kind === 's3' ? d.media.region : null,
      mailHost: d.transport.kind === 'smtp' ? d.transport.host : null,
      mailPort: d.transport.kind === 'smtp' ? d.transport.port : null,
      mailUser: d.transport.kind === 'smtp' ? d.transport.user : null,
      bulkEmailDomain: d.mail.identity.kind === 'tenant' ? d.mail.identity.domain : null,
    }).toEqual({
      slug: stack['slug'],
      siteUrl: stack['siteUrl'],
      uid: stack['uid'],
      hostPort: stack['hostPort'],
      appHostPrivateIp: stack['appHostPrivateIp'],
      imageRef: stack['imageRef'],
      databaseHost: stack['databaseHost'],
      mediaEndpoint: stack['mediaEndpoint'],
      mediaRegion: stack['mediaRegion'],
      mailHost: stack['mailHost'],
      mailPort: stack['mailPort'],
      mailUser: stack['mailUser'],
      bulkEmailDomain: stack['bulkEmailDomain'],
    });
  });

  it('carries the keys the current image refuses to boot without', () => {
    const compose = content(renderedArtefacts(), 'compose.yml');
    for (const feature of ['images', 'media', 'files']) {
      expect(compose).toContain(`storage__${feature}__adapter: 'ScanningStorageAdapter'`);
    }
  });

  it('keeps the backup recipient placeholder out of every artefact', () => {
    const recipient = loadDescriptor().backup;
    if (recipient.kind !== 'bucket-native') throw new Error('tenant zero is bucket-native');
    for (const artefact of renderedArtefacts()) {
      expect(artefact.content).not.toContain(recipient.encryptionRecipient);
    }
  });

  it('names every secret and gives none a value', () => {
    const secrets = content(renderedArtefacts(), 'secrets.env')
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
});

describe('tenant zero descriptor: the control case, refused by validation', () => {
  it.each([
    ['an unknown top-level field', 'unexpectedField', 1],
    ['an unknown nested field on ports', 'ports.c', 8104],
    ['an unknown nested field on database', 'database.password', 'x'],
    ['a stray ownerEmail', 'ownerEmail', 'owner@example.com'],
  ])('refuses %s', (_label, path, value) => {
    expect(() => accepted(mutate(path, value))).toThrow(FieldValidationError);
  });

  it.each([
    ['a port below the tenant range', 'ports.a', 80],
    ['a port above 65535', 'ports.b', 70000],
    ['the health port below 1024', 'ports.health', 22],
    ['two ports the same', 'ports.b', 8101],
    ['a uid below the tenant range', 'uid', 29999],
    ['a uid above the tenant range', 'uid', 31000],
  ])('refuses %s', (_label, path, value) => {
    expect(() => accepted(mutate(path, value))).toThrow(FieldValidationError);
  });

  it('refuses the name when another repository claims it, and when none is given', () => {
    expect(() =>
      validateTenantStack(loadDescriptor(), ZONES, {
        claimantRepo: 'branchLeft/ghost-tenant-other',
      })
    ).toThrow(/registered to branchLeft\/ghost-tenant-blog/);
    expect(() => validateTenantStack(loadDescriptor(), ZONES)).toThrow(FieldValidationError);
  });

  it.each([
    ['INV-1', 'codeInjection', { kind: 'open' }],
    [
      'INV-2',
      'gate',
      { kind: 'passphrase', argon2idHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' },
    ],
    ['INV-3', 'backup', { kind: 'none' }],
  ])('refuses a breach of %s', (invariant, path, value) => {
    let thrown: unknown;
    try {
      accepted(mutate(path, value));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvariantViolationError);
    expect((thrown as InvariantViolationError).invariant).toBe(invariant);
  });
});

// ---------------------------------------------------------------------------
// The reviewed difference.

interface Baseline {
  readonly before: Map<string, string>;
}

const STORAGE_FEATURES = ['images', 'media', 'files'] as const;

function baseline(): Baseline {
  const dir = ['tenant-zero', 'tenant-5.0.0'];
  const before = new Map<string, string>();
  const compose = read(...dir, 'compose.yml');
  const env = 'compose.services.ghost-a.environment.';
  for (const [rawPath, value] of flattenEmitted(compose, 'compose')) {
    // 5.0.0 has one service, `ghost`; blue/green names its colour A `ghost-a`.
    const path = rawPath.replace('compose.services.ghost.', 'compose.services.ghost-a.');
    // 5.0.0 configures one plain S3Storage for every feature; the scanning
    // adapter wraps that same configuration once per feature. Carry each
    // 5.0.0 value over to the key that now holds it, so a value that changed
    // is a difference and not a removal beside an unrelated addition.
    if (path === `${env}storage__active`) {
      for (const feature of STORAGE_FEATURES) before.set(`${env}storage__${feature}__wraps`, value);
    } else if (path.startsWith(`${env}storage__S3Storage__`)) {
      const suffix = path.slice(`${env}storage__S3Storage__`.length);
      for (const feature of STORAGE_FEATURES) {
        before.set(`${env}storage__${feature}__wrappedConfig__${suffix}`, value);
      }
    } else {
      before.set(path, value);
    }
  }
  before.set('compose.service-names', 'ghost');
  before.set('compose.header-comment', headerComment(compose));
  for (const [path] of flattenEnvFile(read(...dir, 'secrets.env'), 'secrets')) {
    before.set(path, '<set by operator>');
  }
  for (const [path, value] of flattenJson(readJson(...dir, 'identity.json'), 'identity')) {
    before.set(path, value);
  }
  for (const [path, value] of flattenJson(readJson(...dir, 'scalars.json'), 'scalars')) {
    before.set(path, value);
  }
  before.set(
    'image.env.IMAGE',
    readJson<{ imageRef: string }>(...dir, 'stack-config.json').imageRef
  );
  for (const [path, value] of flattenJson(readJson(...dir, 'live-edge-entry.json'), 'edge')) {
    before.set(path, value);
  }
  return { before };
}

function headerComment(compose: string): string {
  return compose
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .join('\n');
}

/** What the render core produces, flattened into the same paths as the baseline. */
function after(
  descriptor: TenantStackDescriptor,
  artefacts: readonly Artefact[]
): Map<string, string> {
  const out = new Map<string, string>();
  const compose = content(artefacts, 'compose.yml');
  const flat = flattenEmitted(compose, 'compose');

  // Blue/green: `ghost-b` must be `ghost-a`'s twin on `ports.b`, and nothing else.
  const a = [...flat].filter(([path]) => path.startsWith('compose.services.ghost-a.'));
  const b = new Map(
    [...flat]
      .filter(([path]) => path.startsWith('compose.services.ghost-b.'))
      .map(([path, value]) => [path.replace('ghost-b.', 'ghost-a.'), value])
  );
  const differsFromTwin = a.filter(([path, value]) => b.get(path) !== value).map(([path]) => path);
  expect(differsFromTwin).toEqual(['compose.services.ghost-a.ports.0']);
  expect(b.size).toBe(a.length);
  for (const [path, value] of flat) {
    if (!path.startsWith('compose.services.ghost-b.')) out.set(path, value);
  }
  out.set('compose.service-names', 'ghost-a,ghost-b');
  out.set('compose.header-comment', headerComment(compose));

  for (const [path] of flattenEnvFile(content(artefacts, 'secrets.env'), 'secrets')) {
    out.set(path, '<set by operator>');
  }
  for (const [path, value] of flattenJson(
    JSON.parse(content(artefacts, 'identity.json')),
    'identity'
  )) {
    out.set(path, value);
  }

  const edge = JSON.parse(content(artefacts, 'edge.json')) as { requestBodyMaxSize: string };
  const provision = content(artefacts, 'provision.sh').trim().split('\n').at(-1) as string;
  const scalars: Record<string, string> = {
    composeUnit: composeUnitName(descriptor.slug),
    stackDirectory: stackDirectory(descriptor.slug),
    secretsEnvPath: secretsEnvPath(descriptor.slug),
    imageEnvPath: imageEnvPath(descriptor.slug),
    edgeRequestBodyMaxSize: edge.requestBodyMaxSize,
    hostProvisioningCommand: provision,
    mediaBucket: descriptor.media.kind === 's3' ? descriptor.media.bucket : '',
    mediaPublicBaseUrl:
      descriptor.media.kind === 's3'
        ? mediaPublicBaseUrl(descriptor.media.endpoint, descriptor.slug)
        : '',
    databaseName: databaseAndUserName(descriptor.slug),
    databaseUser: databaseAndUserName(descriptor.slug),
  };
  for (const [key, value] of Object.entries(scalars)) out.set(`scalars.${key}`, value);

  out.set(
    'image.env.IMAGE',
    content(artefacts, 'image.env')
      .trim()
      .replace(/^IMAGE=/, '')
  );
  for (const [path, value] of flattenJson(edge, 'edge')) out.set(path, value);
  out.set('edge.privateUpstreamPort', String(descriptor.ports.a));
  for (const [path, value] of flattenJson(
    JSON.parse(content(artefacts, 'ghost-settings.json')),
    'settings'
  )) {
    out.set(path, value);
  }
  return out;
}

function diffFor(descriptorInput: unknown): Difference[] {
  const descriptor = accepted(descriptorInput);
  return differences(baseline().before, after(descriptor, render(descriptor, ZONES)));
}

const REVIEWED = readJson<readonly ReviewedEntry[]>('tenant-zero', 'reviewed-diff.json');

describe('tenant zero: every difference from what 5.0.0 rendered is judged', () => {
  it('has no difference left unjudged', () => {
    expect(unreviewed(diffFor(loadDescriptor()), REVIEWED)).toEqual([]);
  });

  it('judges no difference that no longer happens', () => {
    expect(stale(diffFor(loadDescriptor()), REVIEWED).map((entry) => entry.id)).toEqual([]);
  });

  it('judges no difference twice', () => {
    expect(judgedTwice(diffFor(loadDescriptor()), REVIEWED)).toEqual([]);
  });

  it('gives every judgement a verdict and a one-line reason', () => {
    for (const entry of REVIEWED) {
      expect(['intended', 'defect']).toContain(entry.status);
      expect(entry.reason.trim()).not.toBe('');
      expect(entry.reason).not.toContain('\n');
      expect(entry.paths.length).toBeGreaterThan(0);
    }
    expect(new Set(REVIEWED.map((entry) => entry.id)).size).toBe(REVIEWED.length);
  });

  // The control case for the gate itself. A descriptor that drifts from the
  // live configuration (a different database host) must surface as an
  // unjudged difference, or the list above judges nothing.
  it.each([
    ['database host', 'database.host', '10.20.1.21', 'database__connection__host'],
    [
      'media endpoint',
      'media.endpoint',
      'https://fsn1.your-objectstorage.com',
      'storage__images__wrappedConfig__endpoint',
    ],
    ['SMTP user', 'transport.user', 'someone@branchleft.co.uk', 'mail__options__auth__user'],
    ['published port', 'ports.a', 8201, 'ports.0'],
  ])('flags a drifted %s as unjudged', (_label, path, value, expectedFragment) => {
    const drifted = unreviewed(diffFor(mutate(path, value)), REVIEWED);
    expect(drifted.length).toBeGreaterThan(0);
    expect(drifted.some((difference) => difference.path.includes(expectedFragment))).toBe(true);
  });
});
