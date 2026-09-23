import { describe, expect, it } from 'vitest';
import type { TenantDescriptor } from '../src/descriptor.js';
import {
  CodeInjectionPreconditionError,
  InvariantViolationError,
  validate,
} from '../src/validate.js';
import { FieldValidationError } from '../src/brand.js';
import { demoDescriptor, tenantDescriptor } from './fixtures.js';

describe('validate() — descriptors that violate nothing', () => {
  it('accepts a well-formed demo descriptor', () => {
    const descriptor = demoDescriptor();
    expect(validate(descriptor)).toBe(descriptor);
  });

  it('accepts a well-formed tenant descriptor', () => {
    const descriptor = tenantDescriptor();
    expect(validate(descriptor)).toBe(descriptor);
  });

  it('accepts a tenant descriptor with a code-injection grant on a verified custom domain', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: {
        kind: 'granted',
        by: 'support@branchleft.co.uk',
        reason: 'Customer support ticket, recorded justification.',
        until: null,
      },
    };
    expect(() => validate(descriptor)).not.toThrow();
  });
});

describe('validate() — INV-1: codeInjection is never open, for any kind', () => {
  it('rejects a descriptor whose codeInjection carries an "open" kind, naming INV-1', () => {
    const descriptor = demoDescriptor();
    // No `Open` variant exists in CodeInjectionSpec — this is exactly the
    // untrusted-JSON path validate() exists to catch, so the sabotage has to
    // go around the type system the same way a parsed HTTP body would.
    const sabotaged = {
      ...descriptor,
      codeInjection: { kind: 'open' },
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(sabotaged);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvariantViolationError);
    expect((caught as InvariantViolationError).invariant).toBe('INV-1');
    expect((caught as Error).message).toContain('INV-1');
  });

  it('rejects "open" even when a hostname exception is offered', () => {
    const descriptor = tenantDescriptor();
    const sabotaged = {
      ...descriptor,
      hostname: {
        kind: 'theirs',
        fqdn: 'blog.acme.example',
        verifiedAt: '2026-09-01T00:00:00.000Z',
      },
      codeInjection: { kind: 'open' },
    } as unknown as TenantDescriptor;

    expect(() => validate(sabotaged)).toThrow(InvariantViolationError);
  });
});

describe('validate() — INV-2: gate = passphrase iff kind = demo', () => {
  it('rejects a demo with no gate, naming INV-2', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), gate: { kind: 'none' } };

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvariantViolationError);
    expect((caught as InvariantViolationError).invariant).toBe('INV-2');
  });

  it('rejects a paying tenant behind a passphrase gate, naming INV-2', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      gate: { kind: 'passphrase', argon2idHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' },
    };

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvariantViolationError);
    expect((caught as InvariantViolationError).invariant).toBe('INV-2');
  });
});

describe('validate() — INV-3: media.kind = s3 implies backup.kind = bucket-native', () => {
  it('rejects an s3-media descriptor with no backup, naming INV-3', () => {
    const descriptor: TenantDescriptor = { ...tenantDescriptor(), backup: { kind: 'none' } };

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvariantViolationError);
    expect((caught as InvariantViolationError).invariant).toBe('INV-3');
    expect((caught as Error).message).toContain('INV-3');
  });
});

describe('validate() — code-injection hostname precondition (load-bearing, not numbered)', () => {
  it('rejects a grant on a platform hostname', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: { kind: 'ours', sub: 'acme', gated: false },
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: null },
    };

    expect(() => validate(descriptor)).toThrow(CodeInjectionPreconditionError);
  });

  it('rejects a managed injection on a platform hostname', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: { kind: 'ours', sub: 'acme', gated: false },
      codeInjection: { kind: 'managed', head: '', foot: '' },
    };

    expect(() => validate(descriptor)).toThrow(CodeInjectionPreconditionError);
  });
});

describe('validate() — per-field well-formedness', () => {
  it('rejects a malformed slug', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), slug: 'Not-Valid' as never };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects a non-absolute siteUrl', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), siteUrl: 'not a url' as never };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects an image reference with no digest', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      image: 'ghost:6.55.0-alpine' as never,
    };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects a uid outside the reserved range', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), uid: 1000 as never };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects an out-of-range port in the port triple', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      ports: { ...demoDescriptor().ports, health: 70000 as never },
    };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects a non-private appHostIp', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), appHostIp: '8.8.8.8' as never };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects an out-of-range mysql port', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      database: {
        ...(tenantDescriptor().database as { kind: 'mysql' } & Record<string, unknown>),
        port: 0,
      } as never,
    };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects an out-of-range smtp port', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      transport: { kind: 'smtp', host: 'mx.example', port: 0 as never, user: 'ghost' },
    };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects a malformed hostname.verifiedAt', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: 'blog.acme.example',
        verifiedAt: 'not-an-instant' as never,
      },
    };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects a malformed codeInjection.until', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: 'soon' as never },
      hostname: {
        kind: 'theirs',
        fqdn: 'demo-1.example',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
    };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects a malformed expiresAt', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      expiresAt: 'not-an-instant' as never,
    };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });
});
