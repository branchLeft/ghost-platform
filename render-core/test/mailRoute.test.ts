/**
 * `mail.route`: which sending target the collector uses for a host's mail.
 * Nothing reads it yet, so these tests pin two things: the schema refuses
 * every value it should (and a demo that asks for anything but mx1), and an
 * absent route, `mx1` and `sweego` all render byte-identical artefacts.
 * See ../src/mail.md#mail-route.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FieldValidationError } from '../src/brand.js';
import type { TenantDescriptor, TenantStackDescriptor } from '../src/descriptor.js';
import { DEFAULT_MAIL_ROUTE, MAIL_ROUTES, mailRouteOf } from '../src/mail.js';
import { render } from '../src/render.js';
import { TierMismatchError, validate, validateTenantStack } from '../src/validate.js';
import {
  TEST_ZONES,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
  tenantDescriptor,
} from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

function withRoute(descriptor: TenantDescriptor, route: unknown): TenantDescriptor {
  return { ...descriptor, mail: { ...descriptor.mail, route } } as unknown as TenantDescriptor;
}

function withoutRoute(descriptor: TenantDescriptor): TenantDescriptor {
  const { route: _route, ...mail } = descriptor.mail;
  return { ...descriptor, mail };
}

function refusalOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('mailRouteOf', () => {
  it('defaults to mx1 when the descriptor carries no route', () => {
    expect(DEFAULT_MAIL_ROUTE).toBe('mx1');
    expect(mailRouteOf(withoutRoute(tenantDescriptor()).mail)).toBe('mx1');
  });

  it.each(MAIL_ROUTES)('reads %s from route.primary', (primary) => {
    expect(mailRouteOf({ route: { primary } })).toBe(primary);
  });

  it('knows exactly two routes', () => {
    expect([...MAIL_ROUTES]).toEqual(['mx1', 'sweego']);
  });
});

describe('validate() -- mail.route', () => {
  it.each(MAIL_ROUTES)('accepts a tenant whose route is %s', (primary) => {
    expect(() => validate(withRoute(tenantDescriptor(), { primary }), TEST_ZONES)).not.toThrow();
  });

  it('accepts a tenant with no route at all', () => {
    expect(() => validate(withoutRoute(tenantDescriptor()), TEST_ZONES)).not.toThrow();
  });

  it.each([
    ['an unknown target', { primary: 'mailgun' }],
    ['a differently cased target', { primary: 'MX1' }],
    ['an empty target', { primary: '' }],
    ['a null target', { primary: null }],
    ['no target', {}],
    ['a fallback key', { primary: 'sweego', fallback: 'mx1' }],
    ['an allowance key', { primary: 'sweego', sweegoAllowance: 100 }],
    ['an exception key', { primary: 'mx1', except: ['login'] }],
    ['a bare string', 'sweego'],
    ['null', null],
    ['an array', ['sweego']],
    ['a number', 1],
  ])('refuses a route that is %s', (_label, route) => {
    const caught = refusalOf(() => validate(withRoute(tenantDescriptor(), route), TEST_ZONES));
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toMatch(/^mail\.route/);
  });

  it('refuses a route on a paying-tenant stack descriptor the same way', () => {
    const { ownerEmail: _ownerEmail, ...stack } = tenantDescriptor();
    const bad = { ...stack, mail: { ...stack.mail, route: { primary: 'mailgun' } } };
    expect(() => validateTenantStack(bad as unknown as TenantStackDescriptor, TEST_ZONES)).toThrow(
      FieldValidationError
    );
  });
});

describe('validate() -- a demo never leaves mx1', () => {
  it('refuses a demo whose route is sweego', () => {
    const caught = refusalOf(() =>
      validate(withRoute(demoDescriptor(), { primary: 'sweego' }), TEST_ZONES)
    );
    expect(caught).toBeInstanceOf(TierMismatchError);
    expect((caught as Error).message).toContain('mail.route');
  });

  it('accepts a demo whose route is mx1, or absent', () => {
    expect(() =>
      validate(withRoute(demoDescriptor(), { primary: 'mx1' }), TEST_ZONES)
    ).not.toThrow();
    expect(() => validate(withoutRoute(demoDescriptor()), TEST_ZONES)).not.toThrow();
  });
});

describe('an absent route changes nothing', () => {
  it('no fixture, and not the committed tenant-zero descriptor, carries a route', () => {
    const blog = JSON.parse(
      readFileSync(join(here, 'tenant-zero', 'blog.descriptor.json'), 'utf-8')
    ) as TenantStackDescriptor;
    const all: Array<{ mail: Pick<TenantDescriptor['mail'], 'route'> }> = [
      demoDescriptor(),
      tenantDescriptor(),
      entryTenantDescriptor(),
      professionalTenantDescriptor(),
      blog,
    ];
    for (const descriptor of all) {
      expect('route' in descriptor.mail).toBe(false);
      expect(mailRouteOf(descriptor.mail)).toBe('mx1');
    }
    expect(() =>
      validateTenantStack(blog, TEST_ZONES, { claimantRepo: 'branchLeft/ghost-tenant-blog' })
    ).not.toThrow();
  });

  it.each([
    ['tenant', tenantDescriptor],
    ['entry tenant', entryTenantDescriptor],
    ['professional tenant', professionalTenantDescriptor],
  ] as const)(
    'renders byte-identical artefacts for a %s whether its route is absent, mx1 or sweego',
    (_label, fixture) => {
      const absent = render(validate(withoutRoute(fixture()), TEST_ZONES), TEST_ZONES);
      for (const primary of MAIL_ROUTES) {
        const routed = render(validate(withRoute(fixture(), { primary }), TEST_ZONES), TEST_ZONES);
        expect(routed).toEqual(absent);
      }
    }
  );

  it('renders a demo identically with an explicit mx1 route', () => {
    const absent = render(validate(withoutRoute(demoDescriptor()), TEST_ZONES), TEST_ZONES);
    const routed = render(
      validate(withRoute(demoDescriptor(), { primary: 'mx1' }), TEST_ZONES),
      TEST_ZONES
    );
    expect(routed).toEqual(absent);
  });

  it('puts no route and no Sweego word in any artefact a tenant host receives', () => {
    const artefacts = render(
      validate(withRoute(tenantDescriptor(), { primary: 'sweego' }), TEST_ZONES),
      TEST_ZONES
    );
    for (const artefact of artefacts) {
      expect(artefact.content.toLowerCase()).not.toContain('sweego');
    }
  });
});
