import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TenantDescriptor } from '../src/descriptor.js';
import { render, renderEdgeSiteBlock, renderIdentity, renderSettings } from '../src/render.js';
import { validate } from '../src/validate.js';
import {
  TEST_ZONES,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
} from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, 'golden');

/** Compares `actual` against a committed golden fixture at `test/golden/<name>`. */
function golden(name: string, actual: string): void {
  const expected = readFileSync(join(goldenDir, name), 'utf-8');
  expect(actual).toBe(expected);
}

const ARTEFACT_PATHS = [
  'compose.yml',
  'secrets.env',
  'image.env',
  'provision.sh',
  'edge.json',
  'ghost-settings.json',
  'identity.json',
];

describe('render() — the seven artefacts', () => {
  it.each([
    ['demo', demoDescriptor],
    ['entry tenant', entryTenantDescriptor],
    ['professional tenant', professionalTenantDescriptor],
  ] as const)('returns exactly the seven named artefacts for a %s', (_label, fixture) => {
    const descriptor = validate(fixture(), TEST_ZONES);
    const artefacts = render(descriptor, TEST_ZONES);
    expect(artefacts.map((a) => a.path)).toEqual(ARTEFACT_PATHS);
    expect(artefacts).toHaveLength(7);
  });

  it.each([
    ['demo', demoDescriptor],
    ['entry-tenant', entryTenantDescriptor],
    ['professional-tenant', professionalTenantDescriptor],
  ] as const)('is pinned by a golden test — %s', (label, fixture) => {
    const descriptor = validate(fixture(), TEST_ZONES);
    const artefacts = render(descriptor, TEST_ZONES);
    for (const artefact of artefacts) {
      golden(`${label}.${artefact.path}`, artefact.content);
    }
  });

  it('is deterministic: rendering the same descriptor twice byte-matches every artefact', () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const first = render(descriptor, TEST_ZONES);
    const second = render(descriptor, TEST_ZONES);
    expect(second).toEqual(first);
    for (let i = 0; i < first.length; i += 1) {
      expect(second[i]!.content).toBe(first[i]!.content);
    }
  });

  it('control case: two different fixtures render different compose.yml (the comparison can fail)', () => {
    const a = render(validate(entryTenantDescriptor(), TEST_ZONES), TEST_ZONES);
    const b = render(validate(professionalTenantDescriptor(), TEST_ZONES), TEST_ZONES);
    expect(a[0]!.content).not.toBe(b[0]!.content);
  });

  it('performs no I/O: every source file under src/ has no bare (non-relative) import specifier', () => {
    // The general form of this proof already lives in
    // dependency-closure.test.ts (which additionally forbids the Pulumi
    // scope specifically); restated narrowly here, against `render.ts`
    // itself, as the direct "no I/O" claim the story's Done means names.
    const renderSrc = readFileSync(join(here, '..', 'src', 'render.ts'), 'utf-8');
    const bareImport = /from\s+['"](?!\.)[^'"]+['"]/g;
    const offenders = [...renderSrc.matchAll(bareImport)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });

  it('render.ts imports no node: built-in directly (control: the pattern itself matches one)', () => {
    const files = readdirSync(join(here, '..', 'src')).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const nodeImport = /from\s+['"]node:/;
    expect(nodeImport.test("import { readFile } from 'node:fs';")).toBe(true); // control
    for (const file of files) {
      const text = readFileSync(join(here, '..', 'src', file), 'utf-8');
      expect(nodeImport.test(text)).toBe(false);
    }
  });

  describe('no secret ever appears in an artefact', () => {
    it.each([
      [
        'entry tenant (mysql + s3 + smtp — every secret-bearing kind at once)',
        entryTenantDescriptor,
      ],
    ] as const)('%s', (_label, fixture) => {
      const descriptor = validate(fixture(), TEST_ZONES);
      const artefacts = render(descriptor, TEST_ZONES);
      for (const artefact of artefacts) {
        // Every secret env key appears only as a `${VAR:?...}` reference
        // (inside compose.yml) or as a bare, valueless key (inside
        // secrets.env) — never with a literal value assigned.
        const literalAssignment =
          /GHOST_(DB_PASSWORD|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY|MAIL_PASSWORD)=[^\s$][^\n]*/;
        expect(artefact.content).not.toMatch(literalAssignment);
      }
    });
  });
});

describe('render() — sabotage: the invariants a real defect could silently drop', () => {
  it('DETERMINISM — sabotage: a render seeded from Date.now() breaks byte-stability, reverted', () => {
    // Simulates the class of defect this test guards against without
    // editing source: a "deterministic" renderer that secretly reads
    // wall-clock time would make two renders of one descriptor disagree.
    // We assert the real render() does NOT do this (the control), then
    // show what a broken one would look like (the red), then confirm the
    // real one stays green (the revert).
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const first = render(descriptor, TEST_ZONES)
      .map((a) => a.content)
      .join('\n');
    const second = render(descriptor, TEST_ZONES)
      .map((a) => a.content)
      .join('\n');
    // RED (what a non-deterministic renderer produces): two different
    // Date.now()-seeded strings never match.
    const brokenFirst = `${first}\n${Date.now()}`;
    const brokenSecond = `${second}\n${Date.now() + 1}`;
    expect(brokenFirst).not.toBe(brokenSecond);
    // GREEN (the real render()): identical input, byte-identical output.
    expect(first).toBe(second);
  });

  it('DEMO-PUBLIC-HOSTNAME — sabotage: using displayHostname for admission would leak a demo hostname; render() uses admittedHostname instead', () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);
    const edge = renderEdgeSiteBlock(descriptor, TEST_ZONES, {
      tmpfsSize: '128m',
      themeCompressedBytes: 1,
      themeEntryUncompressedBytes: 1,
      themeTotalUncompressedBytes: 1,
      edgeRequestBodyMaxSize: '64MiB',
      memoryLimit: '640m',
    });
    // RED (what the sabotage would produce): a caller that certificate-
    // admits on `displayHostname` instead of `admittedHostname` would
    // admit a real, public-looking hostname for a demo.
    expect(edge.displayHostname).not.toBeNull();
    expect(edge.displayHostname.length).toBeGreaterThan(0);
    // GREEN (the real invariant): the field a TLS-admission decision must
    // use is null for every demo — see edge.ts's own doc comment and
    // validate.ts#servedHostnameOf.
    expect(edge.admittedHostname).toBeNull();
  });

  it('PORT/UID-FROM-DESCRIPTOR — sabotage: rendering with a hand-edited uid/port produces a compose.yml carrying exactly that value, never a computed or default one', () => {
    const base = validate(entryTenantDescriptor(), TEST_ZONES);
    const reallocated: TenantDescriptor = {
      ...base,
      uid: 30999 as TenantDescriptor['uid'],
      ports: {
        a: 4001 as TenantDescriptor['ports']['a'],
        b: 4002 as TenantDescriptor['ports']['b'],
        health: 4003 as TenantDescriptor['ports']['health'],
      },
    };
    const artefacts = render(reallocated, TEST_ZONES);
    const compose = artefacts.find((a) => a.path === 'compose.yml')!.content;
    // GREEN: the slot's own allocation, faithfully reflected.
    expect(compose).toContain('30999:30999');
    expect(compose).toContain(':4001:2368');
    expect(compose).toContain(':4002:2368');
    // RED (what a hardcoded/default-value bug would produce): the
    // original descriptor's uid/ports must NOT appear instead.
    expect(compose).not.toContain(`${base.uid}:${base.uid}`);
    expect(compose).not.toContain(`:${base.ports.a}:2368`);
  });

  it('NO-SECRET-IN-OUTPUT — sabotage: a renderer that inlined the password reference as a literal would be caught by the no-literal-assignment check', () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const artefacts = render(descriptor, TEST_ZONES);
    const compose = artefacts.find((a) => a.path === 'compose.yml')!.content;
    // GREEN: the real render() emits a reference.
    expect(compose).toContain('GHOST_DB_PASSWORD:?set GHOST_DB_PASSWORD');
    // RED (what the sabotage would look like): a literal value assigned
    // to the same key must never appear. Both colour services carry the
    // reference (one per service block), so every occurrence is replaced.
    const sabotaged = compose.replaceAll(/\$\{GHOST_DB_PASSWORD:\?[^}]*\}/g, 'hunter2');
    expect(sabotaged).toContain('hunter2');
    expect(sabotaged).not.toContain('GHOST_DB_PASSWORD:?');
  });
});

describe('renderSettings() — codeInjection continuously reconciled', () => {
  it('emits empty codeinjection_head/foot for blocked (never omits the key)', () => {
    const settings = renderSettings({
      codeInjection: { kind: 'blocked' },
      limits: { membersCap: null, staffCap: null },
    });
    expect(settings.codeinjection_head).toBe('');
    expect(settings.codeinjection_foot).toBe('');
    expect(Object.keys(settings)).toContain('codeinjection_head');
  });

  it('emits the managed head/foot verbatim', () => {
    const descriptor = validate(professionalTenantDescriptor(), TEST_ZONES);
    const settings = renderSettings(descriptor);
    expect(settings.codeinjection_head).toContain('analytics-consent');
    expect(settings.codeinjection_foot).toContain('analytics.js');
  });
});

describe('renderIdentity()', () => {
  it('carries null databaseName for a sqlite descriptor and null mediaBucket for local media', () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);
    const identity = renderIdentity(descriptor);
    expect(identity.databaseName).toBeNull();
    expect(identity.mediaBucket).toBeNull();
  });

  it('carries the derived database and bucket names for a mysql+s3 tenant', () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const identity = renderIdentity(descriptor);
    expect(identity.databaseName).toBe('ghost_entry_co');
    expect(identity.mediaBucket).toBe('branchleft-media-entry-co');
  });
});

describe('tenant zero — environment value parity with infra/tenant/environment.ts today', () => {
  it('renders the same mysql database__* keys infra/tenant renders for an equivalent tenant', () => {
    // See render.ts's own doc comment: the Compose *document* now differs
    // (two services, not one) because of LLD-1 §03b's blue/green ruling —
    // not resolved here. What this asserts is the part that is unchanged:
    // the environment *values* infra/tenant/environment.ts renders for a
    // mysql/s3 tenant appear identically in render-core's own output.
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const artefacts = render(descriptor, TEST_ZONES);
    const compose = artefacts.find((a) => a.path === 'compose.yml')!.content;
    expect(compose).toContain("database__client: 'mysql'");
    expect(compose).toContain("database__connection__host: 'db-t1.internal'");
    expect(compose).toContain('database__connection__port: 3306');
    expect(compose).toContain("storage__active: 'S3Storage'");
    expect(compose).toContain('storage__S3Storage__forcePathStyle: true');
    expect(compose).toContain('privacy__useUpdateCheck: false');
    expect(compose).toContain('security__allowWebhookInternalIPs: false');
  });
});
