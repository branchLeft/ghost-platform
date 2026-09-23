import { describe, expect, it } from 'vitest';
import type { TenantDescriptor } from '../src/descriptor.js';
import {
  CodeInjectionPreconditionError,
  InvariantViolationError,
  TierMismatchError,
  UnknownDiscriminantError,
  UnknownSchemaVersionError,
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

describe('validate() — closed-set discriminants, checked before any invariant', () => {
  it('rejects a descriptor kind outside the declared set, with no case normalisation', () => {
    const descriptor = { ...demoDescriptor(), kind: 'Demo' } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect((caught as UnknownDiscriminantError).field).toBe('kind');
  });

  it('rejects a database.kind outside the declared set', () => {
    const descriptor = {
      ...demoDescriptor(),
      database: { kind: 'SQLite', path: '/data/demo-1/ghost.db' },
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect((caught as UnknownDiscriminantError).field).toBe('database');
  });

  it('rejects a media.kind outside the declared set (the reviewed "S3" case)', () => {
    const descriptor = {
      ...tenantDescriptor(),
      media: { kind: 'S3', endpoint: 'https://s3.endpoint.example', region: 'eu', bucket: 'acme' },
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect((caught as UnknownDiscriminantError).field).toBe('media');
  });

  it('rejects a transport.kind outside the declared set', () => {
    const descriptor = {
      ...demoDescriptor(),
      transport: { kind: 'Queue', path: '/var/spool/demo-1' },
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect((caught as UnknownDiscriminantError).field).toBe('transport');
  });

  it('rejects a hostname.kind outside the declared set', () => {
    const descriptor = {
      ...demoDescriptor(),
      hostname: { kind: 'Ours', sub: 'demo-1', gated: true },
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect((caught as UnknownDiscriminantError).field).toBe('hostname');
  });

  it('rejects a gate.kind outside the declared set', () => {
    const descriptor = {
      ...demoDescriptor(),
      gate: { kind: 'Passphrase', argon2idHash: 'x' },
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect((caught as UnknownDiscriminantError).field).toBe('gate');
  });

  it('rejects a backup.kind outside the declared set', () => {
    const descriptor = {
      ...tenantDescriptor(),
      backup: { kind: 'Bucket-Native', encryptionRecipient: 'age1x' },
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect((caught as UnknownDiscriminantError).field).toBe('backup');
  });

  it('rejects a null union field with a named error, not a raw TypeError', () => {
    const descriptor = { ...demoDescriptor(), database: null } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as UnknownDiscriminantError).field).toBe('database');
  });

  it('rejects a union field whose kind is not a string at all', () => {
    const descriptor = {
      ...demoDescriptor(),
      database: { kind: 42, path: '/data/demo-1/ghost.db' },
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect((caught as Error).message).toContain('a non-string kind (number)');
  });

  it('rejects codeInjection: null with a named error, not a raw TypeError', () => {
    const descriptor = { ...demoDescriptor(), codeInjection: null } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvariantViolationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as InvariantViolationError).invariant).toBe('INV-1');
  });

  it('rejects a non-object codeInjection (e.g. a stray number) with a named error', () => {
    const descriptor = { ...demoDescriptor(), codeInjection: 42 } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvariantViolationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('a non-object (number)');
  });

  it('rejects codeInjection: undefined with a named error, not a raw TypeError', () => {
    const descriptor = {
      ...demoDescriptor(),
      codeInjection: undefined,
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvariantViolationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as InvariantViolationError).invariant).toBe('INV-1');
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

  it('rejects "open" even when a hostname exception is offered, naming INV-1', () => {
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

    let caught: unknown;
    try {
      validate(sabotaged);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvariantViolationError);
    expect((caught as InvariantViolationError).invariant).toBe('INV-1');
  });
});

describe('validate() — INV-2: gate = passphrase iff kind = demo', () => {
  it('rejects a demo with no gate, naming INV-2', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      gate: { kind: 'none' },
      hostname: { kind: 'ours', sub: 'demo-1', gated: false },
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

describe('validate() — per-tier variant rules (the rulings, not the three numbered invariants)', () => {
  it('rejects a paying tenant on SQLite', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      database: { kind: 'sqlite', path: '/data/acme/ghost.db' },
    };
    expect(() => validate(descriptor)).toThrow(TierMismatchError);
  });

  it('rejects a paying tenant on local media (the reviewed "media:local, backup:none" case)', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      media: { kind: 'local', path: '/data/acme/content', resize: true, srcsets: true },
    };
    expect(() => validate(descriptor)).toThrow(TierMismatchError);
  });

  it('rejects a demo on MySQL', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      database: {
        kind: 'mysql',
        host: 'db-t1.internal',
        port: 3306 as never,
        name: 'x',
        user: 'x',
      },
    };
    expect(() => validate(descriptor)).toThrow(TierMismatchError);
  });

  it('rejects a demo on object-storage media', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      media: {
        kind: 's3',
        endpoint: 'https://s3.endpoint.example',
        region: 'eu',
        bucket: 'demo-1',
        resize: false,
        srcsets: false,
      },
      // Paired with a bucket-native backup so INV-3 (media "s3" implies
      // backup "bucket-native") does not fire first — this test isolates
      // the tier-variant rule specifically, not INV-3.
      backup: { kind: 'bucket-native', encryptionRecipient: 'age1x' },
    };
    expect(() => validate(descriptor)).toThrow(TierMismatchError);
  });

  it('rejects a demo with a bucket-native backup', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      backup: { kind: 'bucket-native', encryptionRecipient: 'age1x' },
    };
    expect(() => validate(descriptor)).toThrow(TierMismatchError);
  });

  it('rejects a demo carrying a code-injection grant — removed from demos, not merely defaulted off', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: 'demo-1.example',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: null },
    };

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TierMismatchError);
  });

  it('rejects a demo carrying a managed injection', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: 'demo-1.example',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
      codeInjection: { kind: 'managed', head: '', foot: '' },
    };
    expect(() => validate(descriptor)).toThrow(TierMismatchError);
  });
});

describe('validate() — a code-injection grant needs non-empty by and reason', () => {
  it('rejects an empty by', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: { kind: 'granted', by: '', reason: 'ticket', until: null },
    };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });

  it('rejects an empty reason', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: { kind: 'granted', by: 'support', reason: '', until: null },
    };
    expect(() => validate(descriptor)).toThrow(FieldValidationError);
  });
});

describe('validate() — hostname.ours.gated must agree with gate', () => {
  it('rejects a gated hostname with no passphrase gate', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      hostname: { kind: 'ours', sub: 'demo-1', gated: true },
      gate: { kind: 'none' },
    };

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    // INV-2 already forbids a demo with no passphrase gate, so this
    // descriptor is rejected there first; the hostname/gate consistency
    // check below is what fires for a tenant, where INV-2 has nothing to
    // say about the mismatch.
    expect(caught).toBeInstanceOf(InvariantViolationError);
  });

  it('rejects hostname.gated true on a tenant with no passphrase gate', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: { kind: 'ours', sub: 'acme', gated: true },
    };

    let caught: unknown;
    try {
      validate(descriptor);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.gated');
  });
});

describe('validate() — schema version', () => {
  it('rejects a version this package does not know', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), version: 999 };
    expect(() => validate(descriptor)).toThrow(UnknownSchemaVersionError);
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

  it('rejects a malformed owner email', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      ownerEmail: 'not-an-email' as never,
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

  it('rejects an empty backup.encryptionRecipient', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      backup: { kind: 'bucket-native', encryptionRecipient: '  ' },
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

  it('rejects a malformed codeInjection.until on a tenant grant', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: 'soon' as never },
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
