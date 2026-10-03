import { describe, expect, it } from 'vitest';
import { InvalidTenantIdError, parseTenantId } from '../src/tenantId.js';
import { TenantScope, bindTenant } from '../src/tenant/scope.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('parseTenantId', () => {
  it('accepts a canonical lower-case uuid', () => {
    expect(parseTenantId(ID)).toBe(ID);
  });

  it.each([
    ['empty', ''],
    ['upper case', 'abcdefab-1111-4111-8111-111111111111'.toUpperCase()],
    ['trailing text', `${ID}x`],
    ['sql', `${ID}'; DROP TABLE portal.tenant_register; --`],
    ['a number', 7],
    ['undefined', undefined],
    ['null', null],
    ['an object', { toString: () => ID }],
  ])('refuses %s', (_name, value) => {
    expect(() => parseTenantId(value)).toThrow(InvalidTenantIdError);
  });
});

describe('bindTenant', () => {
  it('carries the validated id', () => {
    expect(bindTenant(ID).tenantId).toBe(ID);
  });

  it('refuses an id that is not a tenant id', () => {
    expect(() => bindTenant('not-a-tenant')).toThrow(InvalidTenantIdError);
  });

  it('cannot be constructed without going through bindTenant', () => {
    expect(() => new TenantScope(Symbol('forged'), ID as never)).toThrow(TypeError);
  });
});
