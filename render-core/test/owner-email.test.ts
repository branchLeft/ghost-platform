import { describe, expect, it } from 'vitest';
import { FieldValidationError, type EmailAddress } from '../src/brand.js';
import type { TenantDescriptor, TenantStackDescriptor } from '../src/descriptor.js';
import { SECRET_ENV_KEYS } from '../src/environment.js';
import { render } from '../src/render.js';
import { validate, validateOwnerEmailSecret, validateTenantStack } from '../src/validate.js';
import {
  TEST_ZONES,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
  tenantDescriptor,
} from './fixtures.js';

/**
 * The owner address is a person's, so it must never land in a rendered
 * artefact, and a paying tenant's must reach the host only through the
 * secrets file. A sentinel address no other value could contain makes
 * "appears nowhere" a substring check. See src/descriptor.md#tenant-stack-descriptor.
 */
const SENTINEL_LOCAL = 'owner-sentinel-5c1e9a7b';
const SENTINEL = `${SENTINEL_LOCAL}@sentinel-owner.example.test` as EmailAddress;

function withSentinel(descriptor: TenantDescriptor): TenantDescriptor {
  return { ...descriptor, ownerEmail: SENTINEL };
}

function stackOf(descriptor: TenantDescriptor): TenantStackDescriptor {
  const { ownerEmail: _ownerEmail, ...stack } = descriptor;
  return stack;
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a refusal, got none');
}

const FIXTURES = [
  ['demo', demoDescriptor],
  ['tenant', tenantDescriptor],
  ['entry-tenant', entryTenantDescriptor],
  ['professional-tenant', professionalTenantDescriptor],
] as const;

const PAYING = FIXTURES.filter(([label]) => label !== 'demo');

describe('the owner address in rendered artefacts', () => {
  it.each(FIXTURES)('%s: no artefact contains the owner address', (_label, fixture) => {
    const descriptor = validate(withSentinel(fixture()), TEST_ZONES);
    for (const artefact of render(descriptor, TEST_ZONES)) {
      expect(artefact.content, artefact.path).not.toContain(SENTINEL_LOCAL);
      expect(artefact.content.toLowerCase(), artefact.path).not.toContain(
        SENTINEL_LOCAL.toLowerCase()
      );
    }
  });

  it.each(PAYING)('%s: the secrets template names the owner key, empty', (_label, fixture) => {
    const template = render(validate(withSentinel(fixture()), TEST_ZONES), TEST_ZONES).find(
      (artefact) => artefact.path === 'secrets.env'
    );
    expect(template?.content.split('\n')).toContain(`${SECRET_ENV_KEYS.ownerEmail}=`);
  });

  it('a demo template does not name the owner key: the broker holds a demo owner', () => {
    const template = render(validate(demoDescriptor(), TEST_ZONES), TEST_ZONES).find(
      (artefact) => artefact.path === 'secrets.env'
    );
    expect(template?.content).not.toContain(SECRET_ENV_KEYS.ownerEmail);
  });

  it('the stack descriptor renders exactly what the full descriptor renders', () => {
    const full = validate(withSentinel(tenantDescriptor()), TEST_ZONES);
    const stack = validateTenantStack(stackOf(full), TEST_ZONES);
    expect(render(stack, TEST_ZONES)).toEqual(render(full, TEST_ZONES));
  });
});

describe('validateTenantStack', () => {
  it.each(PAYING)('%s: accepts the descriptor without ownerEmail', (_label, fixture) => {
    const stack = stackOf(fixture());
    expect(validateTenantStack(stack, TEST_ZONES)).toBe(stack);
  });

  it('refuses a descriptor that still carries ownerEmail, without echoing it', () => {
    const error = thrown(() =>
      validateTenantStack(withSentinel(tenantDescriptor()) as TenantStackDescriptor, TEST_ZONES)
    );
    expect(error).toBeInstanceOf(FieldValidationError);
    expect((error as FieldValidationError).field).toBe('ownerEmail');
    expect(error.message).toContain(SECRET_ENV_KEYS.ownerEmail);
    expect(error.message).not.toContain(SENTINEL_LOCAL);
  });

  it('refuses an ownerEmail key even when its value is undefined', () => {
    const stack = { ...stackOf(tenantDescriptor()), ownerEmail: undefined };
    expect(() => validateTenantStack(stack as TenantStackDescriptor, TEST_ZONES)).toThrow(
      /must not carry ownerEmail/
    );
  });

  it('refuses a demo: its owner address is inline and goes through validate()', () => {
    expect(() => validateTenantStack(stackOf(demoDescriptor()), TEST_ZONES)).toThrow(
      /kind "tenant"/
    );
  });

  it('still runs every other check: an unknown key is refused', () => {
    const stack = { ...stackOf(tenantDescriptor()), extra: 1 };
    expect(() => validateTenantStack(stack as TenantStackDescriptor, TEST_ZONES)).toThrow(
      /unknown key\(s\): extra/
    );
  });
});

describe('validateOwnerEmailSecret', () => {
  it('accepts a well-formed address and returns it', () => {
    expect(validateOwnerEmailSecret(SENTINEL)).toBe(SENTINEL);
  });

  it.each([
    `${SENTINEL_LOCAL}-no-at-sign`,
    `${SENTINEL_LOCAL}@nodot`,
    `${SENTINEL_LOCAL} @sentinel-owner.example.test`,
    `${SENTINEL_LOCAL}@a@sentinel-owner.example.test`,
  ])('refuses %j and withholds the value', (value) => {
    const error = thrown(() => validateOwnerEmailSecret(value));
    expect(error).toBeInstanceOf(FieldValidationError);
    expect(error.message).toContain('value withheld');
    expect(error.message).not.toContain(SENTINEL_LOCAL);
  });
});
