import { describe, expect, it } from 'vitest';
import {
  validate,
  validateEmailAddress,
  type TenantDescriptor,
} from '@branchleft/ghost-platform-render-core';
import { zReconcileRequest } from '../src/generated/zod.gen.js';
import { compareParsed } from '../src/parsedDifference.js';
import {
  TEST_ZONES,
  demoDescriptor,
  descriptorForSlot,
  tenantDescriptorFixture,
} from '../test/helpers/fixtures.js';
import { startTestBroker, type TestBroker } from '../test/helpers/testBroker.js';

/**
 * The spec's descriptor schema was written by hand and is enforced at run
 * time in front of render-core's `validate()`, which used to be the only
 * judge. The two must agree in both directions: what `validate()` accepts
 * passes the gate, and what the gate hands the handler is exactly the bytes
 * that were sent, so `validate()` judges the same value it always did.
 */
type Json = Record<string, unknown>;

const TENANT = tenantDescriptorFixture() as unknown as Json;

// The tenant fixture's image is the one a break-glass adapter ships in.
const ZONES = { ...TEST_ZONES, imagesWithBreakGlassAdapter: [TENANT.image as string] };

function oldAccepts(descriptor: unknown): boolean {
  try {
    validate(structuredClone(descriptor) as TenantDescriptor, ZONES);
    return true;
  } catch {
    return false;
  }
}

interface NewPath {
  /** The spec schema accepted it. */
  readonly schema: boolean;
  /** What the handler would receive differs from what was sent. */
  readonly changed: boolean;
  /** Schema, the gate's comparison and then validate() on the parsed copy. */
  readonly accepted: boolean;
}

/** The new path for one descriptor, as the gate and the handler run it. */
function newPath(descriptor: unknown): NewPath {
  const verdict = zReconcileRequest.safeParse({ slot: '0', descriptor });
  if (!verdict.success) return { schema: false, changed: false, accepted: false };
  const diff = compareParsed(descriptor, verdict.data.descriptor);
  const changed = diff.unknown.length + diff.altered.length > 0;
  return { schema: true, changed, accepted: !changed && oldAccepts(verdict.data.descriptor) };
}

function setAt(root: Json, path: readonly string[], value: unknown): Json {
  const copy = structuredClone(root);
  let node: Json = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Json;
  node[path[path.length - 1] as string] = value;
  return copy;
}

function leafPaths(node: unknown, prefix: string[] = []): { path: string[]; value: unknown }[] {
  if (node === null || typeof node !== 'object') return [{ path: prefix, value: node }];
  return Object.entries(node as Json).flatMap(([key, value]) => leafPaths(value, [...prefix, key]));
}

function objectPaths(node: unknown, prefix: string[] = []): string[][] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
  return [
    prefix,
    ...Object.entries(node as Json).flatMap(([key, value]) => objectPaths(value, [...prefix, key])),
  ];
}

const EMAILS = [
  'a@example.com',
  "o'brien@example.com",
  'josé@example.com',
  'a@bücher.example',
  'a@xn--p1ai.example',
  'a@example.xn--p1ai',
  'a@example.c',
  'a@1.2.3.4',
  'a!b@example.com',
  'a#b@example.com',
  'a/b@example.com',
  'a=b@example.com',
  'a.@example.com',
  'a..b@example.com',
  '.a@example.com',
  'a_b@sub_domain.example.com',
  'a@-bad.example.com',
  'A@EXAMPLE.COM',
  'user+tag@mail.example.co.uk',
  'a@localhost.localdomain',
  '张伟@example.cn',
  'a@example.中国',
  'a@a.b',
  'x@example.com.',
  `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}`,
  'no-at-sign',
  'two@@example.com',
  'sp ace@example.com',
  '',
];

const SITE = 'https://k7m-vale-bright.demo-domain.example.test';

/** Forms of a site URL that a format check can trim, strip or accept. */
const SITE_URLS = [
  SITE,
  `${SITE}/`,
  `${SITE}:443`,
  `${SITE}/path?q=1#f`,
  `${SITE.toUpperCase()}`,
  `http://${SITE.slice(8)}`,
  `ftp://${SITE.slice(8)}`,
  `${SITE} `,
  `${SITE}\n`,
  `${SITE}\t`,
  `${SITE}\r\n`,
  `${SITE}\r`,
  `${SITE}\u00a0`,
  `${SITE}\ufeff`,
  `${SITE}\u3000`,
  ` ${SITE}`,
  `\t${SITE}`,
  `\n${SITE}`,
  `\u00a0${SITE}`,
  `\ufeff${SITE}`,
  `\u3000${SITE}`,
  'https://k\t7m-vale-bright.demo-domain.example.test',
  'ht\ttps://k7m-vale-bright.demo-domain.example.test',
  'https://k7m-vale-bright\n.demo-domain.example.test',
  'https:\n//k7m-vale-bright.demo-domain.example.test',
  `${SITE}/\t`,
  'not a url',
];

const STRINGS = [
  ...EMAILS,
  ...SITE_URLS,
  'http://a',
  'https://例え.jp/path',
  'http://[::1]/',
  'http://user:pw@a.b/',
  '2026-09-23T00:00:00Z',
  '2026-09-23T00:00:00.123456Z',
  '2024-02-29T00:00:00Z',
  '2026-02-30T00:00:00Z',
  '2026-09-23T00:00:00+00:00',
  '2026-09-23T00:00:00',
  '2026-09-23T00:00:00Z ',
  ' 2026-09-23T00:00:00Z',
  '2026-09-23',
  '10.0.0.1',
  '10.0.0.01',
  '010.0.0.1',
  '10.0.0.1 ',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.255.254',
  '192.169.0.1',
  '8.8.8.8',
  '::1',
  'x',
  'X',
  'a'.repeat(300),
  ' ',
  'é',
];

const NUMBERS = [0, -1, 1, 1.5, 3000, 30000, 30001, 30999, 31000, 65535, 65536, 2 ** 53 - 1];

const BREAK_GLASS = {
  kind: 'enabled',
  publicKey: 'MCowBQYDK2VwAyEAthisIsATestOnlyBase64SpkiValueNotARealKey=',
  tenant: 'acme',
  supportIdentity: 'support@branchleft.co.uk',
};

describe('the gate agrees with render-core validate() on every descriptor, both ways', () => {
  const fixtures: [string, Json][] = [
    ['demo', demoDescriptor() as unknown as Json],
    ['demo, slot 3', descriptorForSlot('3' as never) as unknown as Json],
    ['tenant', TENANT],
    ['tenant, break-glass enabled', { ...TENANT, breakGlass: BREAK_GLASS }],
    [
      'tenant, code injection granted',
      {
        ...TENANT,
        codeInjection: {
          kind: 'granted',
          by: 'owner',
          reason: 'REASON',
          until: '2026-12-01T00:00:00.000Z',
        },
      },
    ],
    [
      'tenant, code injection managed',
      { ...TENANT, codeInjection: { kind: 'managed', head: '<meta name="x">', foot: '<b></b>' } },
    ],
    [
      'tenant, smtp transport',
      { ...TENANT, transport: { kind: 'smtp', host: 'mx.internal', port: 587, user: 'acme' } },
    ],
  ];

  it('starts from fixtures both sides accept (the control case)', () => {
    for (const [name, descriptor] of fixtures) {
      expect(oldAccepts(descriptor), name).toBe(true);
      expect(newPath(descriptor), name).toEqual({ schema: true, changed: false, accepted: true });
    }
  });

  it('over one-field substitutions: refuses nothing validate() accepts, accepts nothing it refuses, rewrites nothing', () => {
    const full = ['demo', 'tenant'];
    const refusedWrongly: string[] = [];
    const acceptedWrongly: string[] = [];
    const rewritten: string[] = [];
    let accepted = 0;
    let refused = 0;
    for (const [name, base] of fixtures.filter(([n]) => n !== 'demo, slot 3')) {
      for (const { path, value } of leafPaths(base)) {
        // The variants differ from the two base fixtures in one section each,
        // so they take every third value: enough to reach their own fields.
        const strings = full.includes(name) ? STRINGS : STRINGS.filter((_, i) => i % 3 === 0);
        const pool =
          typeof value === 'number' ? NUMBERS : typeof value === 'boolean' ? [!value] : strings;
        for (const candidate of [...pool, null]) {
          const mutated = setAt(base, path, candidate);
          const label = `${name} ${path.join('.')} = ${JSON.stringify(candidate)}`;
          const old = oldAccepts(mutated);
          const now = newPath(mutated);
          if (old) accepted += 1;
          else refused += 1;
          if (old && !now.accepted) refusedWrongly.push(label);
          if (!old && now.accepted) acceptedWrongly.push(label);
          // Whatever the schema lets through must reach the handler unchanged.
          if (now.schema && now.changed) rewritten.push(label);
        }
      }
    }
    expect(refusedWrongly).toEqual([]);
    expect(acceptedWrongly).toEqual([]);
    expect(rewritten).toEqual([]);
    // Neither side of the comparison is vacuous.
    expect(accepted).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(300);
  });

  it('treats each form of siteUrl as validate() does, and never deploys a rewritten one', () => {
    let refusedByOld = 0;
    for (const form of SITE_URLS) {
      const descriptor = setAt(fixtures[0]?.[1] as Json, ['siteUrl'], form);
      const old = oldAccepts(descriptor);
      const now = newPath(descriptor);
      expect(now.accepted, JSON.stringify(form)).toBe(old);
      expect(now.changed, JSON.stringify(form)).toBe(false);
      if (!old) refusedByOld += 1;
    }
    // The pool really does contain forms validate() refuses.
    expect(refusedByOld).toBeGreaterThan(15);
  });

  it('refuses an integer beyond 2^53, which validate() accepts (a stated difference, no real value)', () => {
    const huge = setAt(demoDescriptor() as unknown as Json, ['mail', 'estateCeiling'], 1e21);
    expect(oldAccepts(huge)).toBe(true);
    expect(newPath(huge).accepted).toBe(false);
  });

  it('refuses an unknown field at every object level, as validate() does', () => {
    let tried = 0;
    for (const [name, base] of fixtures) {
      for (const where of objectPaths(base)) {
        for (const key of ['zzExtra', '__proto__']) {
          const mutated = structuredClone(base);
          let node: Json = mutated;
          for (const step of where) node = node[step] as Json;
          Object.defineProperty(node, key, {
            value: 1,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          tried += 1;
          expect(oldAccepts(mutated), `${name} ${where.join('.')} ${key}: validate()`).toBe(false);
          expect(newPath(mutated).accepted, `${name} ${where.join('.')} ${key}: new`).toBe(false);
        }
      }
    }
    expect(tried).toBeGreaterThan(60);
  });
});

describe('owner emails render-core accepts are accepted by the gate, over a real signed /reconcile', () => {
  let broker: TestBroker | undefined;

  it('agrees with validateEmailAddress on every form in the list', () => {
    const disagreements = EMAILS.filter((email) => {
      let old = true;
      try {
        validateEmailAddress(email);
      } catch {
        old = false;
      }
      const schema = zReconcileRequest.safeParse({
        slot: '0',
        descriptor: { ...descriptorForSlot('0' as never), ownerEmail: email },
      });
      // The gate may be no stricter: whatever render-core accepts must pass.
      return old && !schema.success;
    });
    expect(disagreements).toEqual([]);
  });

  for (const email of [
    'josé@example.com',
    '张伟@example.cn',
    'a@bücher.example',
    'a@a.b',
    'a/b@example.com',
    'a_b@sub_domain.example.com',
  ]) {
    it(`deploys a descriptor whose owner is ${email}`, async () => {
      broker = await startTestBroker();
      try {
        const res = await broker.signedFetch('POST', '/reconcile', {
          slot: '0',
          descriptor: { ...descriptorForSlot('0' as never), ownerEmail: email },
        });
        expect(res.status).toBe(200);
        expect(broker.renderer.calls).toHaveLength(1);
      } finally {
        await broker.close();
        broker = undefined;
      }
    });
  }

  it('refuses a siteUrl with a trailing newline over the wire, instead of deploying it trimmed', async () => {
    broker = await startTestBroker();
    const descriptor = descriptorForSlot('0' as never);
    const res = await broker.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: { ...descriptor, siteUrl: `${descriptor.siteUrl}\n` },
    });
    expect(res.status).toBe(400);
    expect(broker.renderer.calls).toHaveLength(0);
    await broker.close();
    broker = undefined;
  });
});
