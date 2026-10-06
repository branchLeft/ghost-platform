import * as fs from 'node:fs';
import * as path from 'node:path';
import { validate, type TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { composePaths, diff, envFilePaths, flatten, type DiffEntry } from './test/diff';
import { TEST_ZONES, tenantZeroEquivalent, tenantZeroSecrets } from './test/fixtures';
import { installMocks, unwrap } from './test/harness';

/**
 * The reviewed, intentional output diff: what the 4.0.0 component rendered
 * for a tenant-zero-equivalent configuration, against what this component
 * renders for the same configuration as a descriptor. Every changed value is
 * listed in `test/golden/reviewed-output-diff.json` and tied to a ratified
 * decision; a change not listed, or a listed change that no longer happens,
 * fails. See output-diff.md.
 */

const GOLDEN = path.join(__dirname, 'test', 'golden');
const BEFORE = path.join(GOLDEN, 'tenant-4.0.0');

/** The ratified decisions a changed value may be tied to. See output-diff.md#decisions. */
const DECISIONS = new Set([
  'blue-green',
  'scanning-wrapper',
  'mail-spool',
  'single-renderer',
  'render-core-artefact',
]);

interface ReviewedEntry extends DiffEntry {
  decision: string;
}

function read(name: string): string {
  return fs.readFileSync(path.join(BEFORE, name), 'utf8');
}

function beforePaths(): Map<string, unknown> {
  const compose = composePaths(read('compose.yml'));
  compose.set('compose.serviceNames', serviceNames(compose));
  const out = new Map<string, unknown>([
    ...compose,
    ...envFilePaths(read('secrets.env'), 'secrets'),
    ...flatten(JSON.parse(read('identity.json')), 'identity'),
    ...flatten(JSON.parse(read('scalars.json')), 'output'),
  ]);
  return out;
}

let GhostTenant: typeof GhostTenantClass;

beforeAll(async () => {
  installMocks();
  ({ GhostTenant } = await import('./index.js'));
});

async function afterPaths(): Promise<Map<string, unknown>> {
  const tenant = new GhostTenant('zero', {
    descriptor: tenantZeroEquivalent(),
    zones: TEST_ZONES,
    secrets: tenantZeroSecrets(),
  });
  const outputs = {
    stackName: tenant.stackName,
    stackDirectory: tenant.stackDirectory,
    composeUnit: tenant.composeUnit,
    secretsEnvPath: tenant.secretsEnvPath,
    imageEnvPath: tenant.imageEnvPath,
    contentVolume: tenant.contentVolume,
    adaptersVolume: tenant.adaptersVolume,
    databaseName: tenant.databaseName,
    databaseUser: tenant.databaseUser,
    mediaBucket: tenant.mediaBucket,
    mediaPublicBaseUrl: tenant.mediaPublicBaseUrl,
    edgeRequestBodyMaxSize: tenant.edgeRequestBodyMaxSize,
    imageEnvFile: tenant.imageEnvFile,
    provisionScript: tenant.provisionScript,
    edgeSiteBlock: tenant.edgeSiteBlock,
    ghostSettings: tenant.ghostSettings,
  };
  return new Map<string, unknown>([
    ...colourA(composePaths(tenant.composeFile)),
    ...envFilePaths(await unwrap(tenant.secretsEnvFile), 'secrets'),
    ...flatten(await unwrap(tenant.identity), 'identity'),
    ...flatten(outputs, 'output'),
  ]);
}

/**
 * Compares colour A against 4.0.0's single service, so the diff shows value
 * changes rather than every path moving; colour B is held to colour A by its
 * own test below. The service list itself is kept as one synthetic path.
 */
function colourA(paths: Map<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of paths) {
    if (key.startsWith('compose.services.ghost-a.')) {
      out.set(`compose.services.ghost.${key.slice('compose.services.ghost-a.'.length)}`, value);
    } else if (!key.startsWith('compose.services.ghost-b.')) {
      out.set(key, value);
    }
  }
  out.set('compose.serviceNames', serviceNames(paths));
  return out;
}

function serviceNames(paths: Map<string, unknown>): string {
  const names = new Set<string>();
  for (const key of paths.keys()) {
    const match = /^compose\.services\.([^.]+)\./.exec(key);
    if (match !== null) {
      names.add(match[1]);
    }
  }
  return [...names].sort().join(',');
}

function reviewed(): ReviewedEntry[] {
  return JSON.parse(
    fs.readFileSync(path.join(GOLDEN, 'reviewed-output-diff.json'), 'utf8')
  ) as ReviewedEntry[];
}

describe('the reviewed output diff against tenant 4.0.0', () => {
  it('ties every reviewed change to a ratified decision', () => {
    for (const entry of reviewed()) {
      expect(DECISIONS.has(entry.decision), `${entry.path}: ${entry.decision}`).toBe(true);
    }
  });

  it('changes exactly the reviewed values, and nothing else', async () => {
    const actual = diff(beforePaths(), await afterPaths());
    const expected = reviewed().map(({ decision: _decision, ...entry }) => entry);
    expect(actual).toEqual(expected);
  });

  it('renders colour B as colour A on the second port of the pair', () => {
    const tenant = new GhostTenant('colours', {
      descriptor: tenantZeroEquivalent(),
      zones: TEST_ZONES,
      secrets: tenantZeroSecrets(),
    });
    const paths = composePaths(tenant.composeFile);
    const colour = (name: string) =>
      new Map(
        [...paths]
          .filter(([key]) => key.startsWith(`compose.services.${name}.`))
          .map(([key, value]) => [key.slice(`compose.services.${name}.`.length), value])
      );
    const differences = diff(colour('ghost-a'), colour('ghost-b'));
    expect(differences).toEqual([
      {
        change: 'changed',
        path: 'ports.0',
        before: '10.20.1.100:8101:2368',
        after: '10.20.1.100:8102:2368',
      },
    ]);
  });

  it('keeps every identity field the delete guard compares', async () => {
    const actual = diff(beforePaths(), await afterPaths());
    expect(actual.filter((entry) => entry.path.startsWith('identity.'))).toEqual([]);
  });
});

describe('tenant zero itself', () => {
  // See output-diff.md#the-slug. When a render core release stops reserving
  // tenant zero's slug, this fails, and the fixture moves to the real slug.
  it('is refused by render core 0.1.0, which reserves its slug', () => {
    const tenantZero = {
      ...tenantZeroEquivalent(),
      slug: 'blog',
      siteUrl: 'https://blog.platform-domain.example.test',
      hostname: { kind: 'ours', sub: 'blog', gated: false },
      database: { ...tenantZeroEquivalent().database, name: 'ghost_blog', user: 'ghost_blog' },
      media: { ...tenantZeroEquivalent().media, bucket: 'branchleft-media-blog' },
    } as unknown as TenantDescriptor;
    expect(() => validate(tenantZero, TEST_ZONES)).toThrow(/reserved/);
  });
});
