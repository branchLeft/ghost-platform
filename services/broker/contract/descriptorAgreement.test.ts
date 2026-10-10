import { describe, expect, it } from 'vitest';
import {
  validate,
  validateEmailAddress,
  type TenantDescriptor,
} from '@branchleft/ghost-platform-render-core';
import { zReconcileRequest } from '../src/generated/zod.gen.js';
import { unknownFieldPaths } from '../src/unknownFields.js';
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
 * judge. The two must agree: a descriptor `validate()` accepts has to pass
 * the gate, and a descriptor `validate()` refuses for an unknown field has to
 * be refused by the gate too (the generated schema would drop the field).
 */
type Json = Record<string, unknown>;

function oldAccepts(descriptor: unknown): boolean {
  try {
    validate(structuredClone(descriptor) as TenantDescriptor, TEST_ZONES);
    return true;
  } catch {
    return false;
  }
}

/** What the gate does to the descriptor: the spec schema, then the unknown-field comparison. */
function gateAccepts(descriptor: unknown): boolean {
  const verdict = zReconcileRequest.safeParse({ slot: '0', descriptor });
  if (!verdict.success) return false;
  return unknownFieldPaths(descriptor, verdict.data.descriptor, 'descriptor').length === 0;
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

const STRINGS = [
  ...EMAILS,
  'http://a',
  'https://例え.jp/path',
  'HTTP://A.B',
  'https://a.b:8080/x?y#z',
  'http://[::1]/',
  'http://user:pw@a.b/',
  'ftp://a.b/',
  'not a url',
  '2026-09-23T00:00:00Z',
  '2026-09-23T00:00:00.123456Z',
  '2024-02-29T00:00:00Z',
  '2026-02-30T00:00:00Z',
  '2026-09-23T00:00:00+00:00',
  '2026-09-23T00:00:00',
  '2026-09-23',
  '10.0.0.1',
  '10.0.0.01',
  '010.0.0.1',
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

describe('the gate agrees with render-core validate() on every descriptor it accepted', () => {
  const fixtures: [string, Json][] = [
    ['demo', demoDescriptor() as unknown as Json],
    ['demo, slot 3', descriptorForSlot('3' as never) as unknown as Json],
    ['tenant', tenantDescriptorFixture() as unknown as Json],
  ];

  it('accepts the fixtures themselves (the control case: both sides say yes)', () => {
    for (const [name, descriptor] of fixtures) {
      expect(oldAccepts(descriptor), name).toBe(true);
      expect(gateAccepts(descriptor), name).toBe(true);
    }
  });

  it('never refuses a one-field substitution that validate() accepts', () => {
    let accepted = 0;
    let refused = 0;
    const disagreements: string[] = [];
    for (const [name, base] of fixtures) {
      for (const { path, value } of leafPaths(base)) {
        const pool =
          typeof value === 'number' ? NUMBERS : typeof value === 'boolean' ? [!value] : STRINGS;
        for (const candidate of [...pool, null]) {
          const mutated = setAt(base, path, candidate);
          if (!oldAccepts(mutated)) {
            refused += 1;
            continue;
          }
          accepted += 1;
          if (!gateAccepts(mutated)) {
            disagreements.push(`${name} ${path.join('.')} = ${JSON.stringify(candidate)}`);
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
    // Neither side of the comparison is vacuous.
    expect(accepted).toBeGreaterThan(200);
    expect(refused).toBeGreaterThan(200);
  });

  it('refuses an integer beyond 2^53, which validate() accepts (a stated difference, no real value)', () => {
    const huge = setAt(demoDescriptor() as unknown as Json, ['mail', 'estateCeiling'], 1e21);
    expect(oldAccepts(huge)).toBe(true);
    expect(gateAccepts(huge)).toBe(false);
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
          expect(gateAccepts(mutated), `${name} ${where.join('.')} ${key}: gate`).toBe(false);
        }
      }
    }
    expect(tried).toBeGreaterThan(40);
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
});
