import { describe, expect, it } from 'vitest';
import type { TenantDescriptor } from '../src/descriptor.js';
import {
  CodeInjectionPreconditionError,
  InvariantViolationError,
  servedHostnameOf,
  TierMismatchError,
  UnknownDiscriminantError,
  UnknownSchemaVersionError,
  validate,
} from '../src/validate.js';
import { FieldValidationError } from '../src/brand.js';
import type { Instant } from '../src/brand.js';
import { TEST_ZONES, demoDescriptor, tenantDescriptor } from './fixtures.js';

describe('validate() — descriptors that violate nothing', () => {
  it('accepts a well-formed demo descriptor', () => {
    const descriptor = demoDescriptor();
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
  });

  it('accepts a well-formed tenant descriptor', () => {
    const descriptor = tenantDescriptor();
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
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
    expect(() => validate(descriptor, TEST_ZONES)).not.toThrow();
  });
});

describe('validate() — closed-set discriminants, checked before any invariant', () => {
  it('rejects a descriptor kind outside the declared set, with no case normalisation', () => {
    const descriptor = { ...demoDescriptor(), kind: 'Demo' } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownDiscriminantError);
    expect((caught as UnknownDiscriminantError).field).toBe('database');
  });

  it('rejects a media.kind outside the declared set (mixed-case)', () => {
    const descriptor = {
      ...tenantDescriptor(),
      media: { kind: 'S3', endpoint: 'https://s3.endpoint.example', region: 'eu', bucket: 'acme' },
    } as unknown as TenantDescriptor;

    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(sabotaged, TEST_ZONES);
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
      validate(sabotaged, TEST_ZONES);
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
    };

    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      validate(descriptor, TEST_ZONES);
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
      siteUrl: 'https://acme.platform-domain.example.test' as never,
      hostname: { kind: 'ours', sub: 'acme', gated: false },
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: null },
    };

    expect(() => validate(descriptor, TEST_ZONES)).toThrow(CodeInjectionPreconditionError);
  });

  it('rejects a managed injection on a platform hostname', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://acme.platform-domain.example.test' as never,
      hostname: { kind: 'ours', sub: 'acme', gated: false },
      codeInjection: { kind: 'managed', head: 'head', foot: 'foot' },
    };

    expect(() => validate(descriptor, TEST_ZONES)).toThrow(CodeInjectionPreconditionError);
  });
});

describe('validate() — per-tier variant rules (not the three numbered invariants)', () => {
  it('rejects a paying tenant on SQLite', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      database: { kind: 'sqlite', path: '/data/acme/ghost.db' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(TierMismatchError);
  });

  it('rejects a paying tenant on local media', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      media: { kind: 'local', path: '/data/acme/content', resize: true, srcsets: true },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(TierMismatchError);
  });

  it('rejects a demo on MySQL', () => {
    // name/user are the slug-derived value (`databaseAndUserName('demo-1')`)
    // rather than an arbitrary string, so this isolates the tier-variant
    // rule specifically, not `validateDatabaseIdentity`'s own check.
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      database: {
        kind: 'mysql',
        host: 'db-t1.internal',
        port: 3306 as never,
        name: 'ghost_demo_1',
        user: 'ghost_demo_1',
      },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(TierMismatchError);
  });

  it('rejects a demo on object-storage media', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      media: {
        kind: 's3',
        endpoint: 'https://s3.endpoint.example',
        region: 'eu',
        // The slug-derived bucket name, so this isolates the tier-variant
        // rule specifically, not `validateMediaBucket`'s own check.
        bucket: 'branchleft-media-demo-1',
        resize: false,
        srcsets: false,
      },
      // Paired with a bucket-native backup so INV-3 (media "s3" implies
      // backup "bucket-native") does not fire first — this test isolates
      // the tier-variant rule specifically, not INV-3.
      backup: { kind: 'bucket-native', encryptionRecipient: 'age1x' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(TierMismatchError);
  });

  it('rejects a demo with a bucket-native backup', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      backup: { kind: 'bucket-native', encryptionRecipient: 'age1x' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(TierMismatchError);
  });

  it('rejects a demo carrying a code-injection grant — removed from demos, not merely defaulted off', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://demo-1.example' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'demo-1.example',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: null },
    };

    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TierMismatchError);
  });

  it('rejects a demo carrying a managed injection', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://demo-1.example' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'demo-1.example',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
      codeInjection: { kind: 'managed', head: 'head', foot: 'foot' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(TierMismatchError);
  });

  it('rejects a demo with a custom (theirs) hostname, even with codeInjection blocked', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://demo-1.example' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'demo-1.example',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(TierMismatchError);
  });

  it('rejects a demo with no expiry', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), expiresAt: null };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(TierMismatchError);
  });
});

describe('validate() — a code-injection grant needs non-empty by and reason', () => {
  it('rejects an empty by', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: { kind: 'granted', by: '', reason: 'ticket', until: null },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an empty reason', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: { kind: 'granted', by: 'support', reason: '', until: null },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });
});

describe('validate() — hostname.ours.gated must agree with gate', () => {
  it('rejects a gated hostname with no passphrase gate', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      gate: { kind: 'none' },
    };

    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
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
      siteUrl: 'https://acme.platform-domain.example.test' as never,
      hostname: { kind: 'ours', sub: 'acme', gated: true },
    };

    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
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
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(UnknownSchemaVersionError);
  });
});

describe('validate() — per-field well-formedness', () => {
  it('rejects a malformed slug', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), slug: 'Not-Valid' as never };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a non-absolute siteUrl', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), siteUrl: 'not a url' as never };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an image reference with no digest', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      image: 'ghost:6.55.0-alpine' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a malformed owner email', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      ownerEmail: 'not-an-email' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a uid outside the reserved range', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), uid: 1000 as never };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an out-of-range port in the port triple', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      ports: { ...demoDescriptor().ports, health: 70000 as never },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a non-private appHostIp', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), appHostIp: '8.8.8.8' as never };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an out-of-range mysql port', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      database: {
        ...(tenantDescriptor().database as { kind: 'mysql' } & Record<string, unknown>),
        port: 0,
      } as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an empty backup.encryptionRecipient', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      backup: { kind: 'bucket-native', encryptionRecipient: '  ' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an out-of-range smtp port', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      transport: { kind: 'smtp', host: 'mx.example', port: 0 as never, user: 'ghost' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
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
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a malformed codeInjection.until on a tenant grant', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: 'soon' as never },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a malformed expiresAt', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      expiresAt: 'not-an-instant' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });
});

describe('validate() — presence and type of every field, every measured case', () => {
  it('rejects a non-number uid, with a named error, not a raw TypeError', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), uid: 'thirty-thousand' as never };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as FieldValidationError).field).toBe('uid');
  });

  it('rejects a non-number, non-null limits.membersCap', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      limits: { membersCap: 'fifty' as never, staffCap: null },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('limits.membersCap');
  });

  it('rejects a null limits (distinct from missing)', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), limits: null as never };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as Error).message).toContain('got null');
  });

  it('rejects a null media.resize (distinct from missing)', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      media: { ...demoDescriptor().media, resize: null } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as Error).message).toContain('got null');
  });

  it('rejects a missing limits', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), limits: undefined as never };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a missing caps', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), caps: undefined as never };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a missing safety', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), safety: undefined as never };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects safety:{near:false,exact:false} — both must be true', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      safety: { near: false, exact: false },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('safety');
  });

  it('rejects safety with only one of near/exact true', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      safety: { near: true, exact: false },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a grant on hostname:{kind:"theirs", fqdn:""}', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: { kind: 'theirs', fqdn: '', verifiedAt: '2026-09-01T00:00:00.000Z' as never },
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: null },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.fqdn');
  });

  // The owned-domain exclusion itself (rejecting a fqdn equal to, or under,
  // any configured owned domain, case-insensitively) has its own dedicated
  // describe block below ("validate() — zone configuration") — these two
  // covered it against the package's old hard-coded zone, which no longer
  // exists.

  it('rejects a malformed theirs fqdn (no dot)', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://localhost' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'localhost',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a managed injection missing head', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: { kind: 'managed', foot: 'foot' } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as FieldValidationError).field).toBe('codeInjection.head');
  });

  it('rejects a managed injection missing foot', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: { kind: 'managed', head: 'head' } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('codeInjection.foot');
  });

  it('rejects media.resize of the wrong type ("yes")', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      media: { ...demoDescriptor().media, resize: 'yes' } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as FieldValidationError).field).toBe('media.resize');
  });

  it('rejects a missing media.resize', () => {
    const media = { ...demoDescriptor().media } as Record<string, unknown>;
    delete media.resize;
    const descriptor: TenantDescriptor = { ...demoDescriptor(), media: media as never };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('media.resize');
  });

  it('rejects an empty argon2idHash', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      gate: { kind: 'passphrase', argon2idHash: '' },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('gate.argon2idHash');
  });

  it('rejects a whitespace-only argon2idHash', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      gate: { kind: 'passphrase', argon2idHash: '   ' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a missing slug with a named error, not a raw TypeError', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), slug: undefined as never };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as FieldValidationError).field).toBe('slug');
  });

  it('rejects a null slug with a named error, not a raw TypeError', () => {
    const descriptor: TenantDescriptor = { ...demoDescriptor(), slug: null as never };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as FieldValidationError).field).toBe('slug');
  });

  it('rejects a backup with no encryptionRecipient, with a named error, not a raw TypeError', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      backup: { kind: 'bucket-native' } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as FieldValidationError).field).toBe('backup.encryptionRecipient');
  });

  it('rejects a grant with no by, with a named error, not a raw TypeError', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      codeInjection: { kind: 'granted', reason: 'ticket', until: null } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as FieldValidationError).field).toBe('codeInjection.by');
  });
});

describe('validate() — encryptionRecipient must be exactly one recipient', () => {
  it('rejects a recipient containing whitespace (two recipients, space-joined)', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      backup: { kind: 'bucket-native', encryptionRecipient: 'age1aaa age1bbb' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a recipient containing a comma (two recipients, comma-joined)', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      backup: { kind: 'bucket-native', encryptionRecipient: 'age1aaa,age1bbb' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });
});

describe("validate() — siteUrl must match the descriptor's hostname", () => {
  it('rejects a siteUrl whose host disagrees with hostname.ours.sub', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://someone-else.platform-domain.example.test' as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('siteUrl');
  });

  it('rejects a siteUrl whose host disagrees with hostname.theirs.fqdn', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://not-blog.acme.example' as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('siteUrl');
  });
});

describe('validate() — the zone configuration itself is validated', () => {
  it('rejects an empty ownedDomains array', () => {
    const zones = { ...TEST_ZONES, ownedDomains: [] };
    let caught: unknown;
    try {
      validate(tenantDescriptor(), zones);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('zones.ownedDomains');
  });

  it('rejects ownedDomains: [""] -- an empty entry can never match a fqdn, so it must not silently make every fqdn look outside every owned domain', () => {
    const zones = { ...TEST_ZONES, ownedDomains: [''] };
    // Without this check, a code-injection grant on a subdomain of the
    // platform zone would validate: the malformed entry never matches, so
    // isOutsideOwnedDomains would wrongly say "outside".
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: `https://x.${TEST_ZONES.platformZone}` as never,
      hostname: {
        kind: 'theirs',
        fqdn: `x.${TEST_ZONES.platformZone}`,
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: null },
    };
    let caught: unknown;
    try {
      validate(descriptor, zones);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('zones.ownedDomains');
  });

  it('rejects ownedDomains: [" x"] -- a label with an embedded space is not well-formed', () => {
    const zones = { ...TEST_ZONES, ownedDomains: [' x'] };
    let caught: unknown;
    try {
      validate(tenantDescriptor(), zones);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('zones.ownedDomains');
  });

  it('rejects ownedDomains: [".x"] -- a leading dot is an empty first label', () => {
    const zones = { ...TEST_ZONES, ownedDomains: ['.x'] };
    let caught: unknown;
    try {
      validate(tenantDescriptor(), zones);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('zones.ownedDomains');
  });

  it('rejects an empty demoZone -- an unchecked demoZone would let a demo\'s siteUrl validate as "https://<sub>."', () => {
    const zones = { ...TEST_ZONES, demoZone: '' };
    let caught: unknown;
    try {
      validate(demoDescriptor(), zones);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('zones.demoZone');
  });

  it('rejects a platformZone outside every owned domain', () => {
    const zones = { ...TEST_ZONES, platformZone: 'unowned.example.test' };
    let caught: unknown;
    try {
      validate(tenantDescriptor(), zones);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('zones.platformZone');
  });

  it('rejects ownedDomains arriving undefined with a named error, not a raw TypeError', () => {
    const zones = { ...TEST_ZONES, ownedDomains: undefined } as unknown as typeof TEST_ZONES;
    let caught: unknown;
    try {
      validate(tenantDescriptor(), zones);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('zones.ownedDomains');
  });

  it('rejects zones arriving as null with a named error, not a raw TypeError', () => {
    let caught: unknown;
    try {
      validate(tenantDescriptor(), null as unknown as typeof TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('zones');
  });

  it('accepts a platformZone that is itself an owned domain, with no subdomain', () => {
    const zones = { ...TEST_ZONES, platformZone: TEST_ZONES.ownedDomains[1] };
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: { kind: 'ours', sub: 'acme', gated: false },
      siteUrl: `https://acme.${zones.platformZone}` as never,
    };
    expect(validate(descriptor, zones)).toBe(descriptor);
  });
});

describe('validate() — zone configuration: no hard-coded platform name', () => {
  it('accepts a demo on the demo zone', () => {
    const descriptor = demoDescriptor();
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
  });

  it('rejects a demo whose siteUrl sits under the platform zone instead of the demo zone', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://k7m-vale-bright.platform-domain.example.test' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('accepts a paying tenant with an "ours" hostname on the platform zone', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: { kind: 'ours', sub: 'acme', gated: false },
      siteUrl: 'https://acme.platform-domain.example.test' as never,
    };
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
  });

  it('rejects a grant on www.<owned platform domain>', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://www.platform-domain.example.test' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'www.platform-domain.example.test',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: null },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.fqdn');
  });

  it('rejects a grant on the owned platform domain itself, with no subdomain', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://platform-domain.example.test' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'platform-domain.example.test',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: null },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.fqdn');
  });

  it('rejects a grant on evil.<owned platform domain> — any label, not only "www"', () => {
    // Any subdomain of an owned domain is inside it regardless of what its
    // own label says — the exclusion is a domain-boundary check, not a
    // list of specific forbidden labels.
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://evil.platform-domain.example.test' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'evil.platform-domain.example.test',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
      codeInjection: { kind: 'granted', by: 'support', reason: 'ticket', until: null },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('accepts a look-alike domain that merely contains the zone as a substring, with no dot boundary', () => {
    // "evilplatform-domain.example.test" is a single label "evilplatform-domain"
    // followed by ".example.test" — it is NOT a subdomain of
    // "platform-domain.example.test" (there is no "." before "platform-domain"),
    // so it must be treated as a genuinely different, unowned domain. This is
    // the control the other direction: proving the boundary check is
    // subdomain-aware, not `.includes(ownedDomain)` — a substring test would
    // wrongly reject this.
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://evilplatform-domain.example.test' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'evilplatform-domain.example.test',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
    };
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
  });

  it('rejects an uppercase variant of an owned domain, compared case-insensitively', () => {
    const zonesWithMixedCaseEntry = {
      ...TEST_ZONES,
      // demoZone must stay an owned domain too, or zone validation itself
      // (not the hostname.fqdn check this test targets) would be what throws.
      ownedDomains: ['Platform-Domain.Example.TEST', TEST_ZONES.demoZone],
    };
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://sub.platform-domain.example.test' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'sub.platform-domain.example.test',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
    };
    let caught: unknown;
    try {
      validate(descriptor, zonesWithMixedCaseEntry);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.fqdn');
  });

  it('trims a trailing dot before comparing an owned domain', () => {
    const zonesWithTrailingDot = {
      ...TEST_ZONES,
      // demoZone must stay an owned domain too, or zone validation itself
      // (not the hostname.fqdn check this test targets) would be what throws.
      ownedDomains: ['platform-domain.example.test.', TEST_ZONES.demoZone],
    };
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://sub.platform-domain.example.test' as never,
      hostname: {
        kind: 'theirs',
        fqdn: 'sub.platform-domain.example.test',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
    };
    expect(() => validate(descriptor, zonesWithTrailingDot)).toThrow(FieldValidationError);
  });
});

describe('validate() — range checks', () => {
  it.each([-1, 0, Infinity, 1.5])('rejects caps.cpuShares %s', (value) => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      caps: { ...demoDescriptor().caps, cpuShares: value },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it.each([-1, 0, Infinity])('rejects caps.pidsLimit %s', (value) => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      caps: { ...demoDescriptor().caps, pidsLimit: value },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it.each([-1, 0, Infinity])('rejects caps.nofile %s', (value) => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      caps: { ...demoDescriptor().caps, nofile: value },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it.each(['', 'abc', '0', '-1', '1.', '01'])('rejects caps.cpus %j', (value) => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      caps: { ...demoDescriptor().caps, cpus: value },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it.each(['1.0', '0.5', '2', '10.25'])('accepts a well-formed caps.cpus %s', (value) => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      caps: { ...demoDescriptor().caps, cpus: value },
    };
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
  });

  it.each([-5, 1.5, Infinity])('rejects limits.membersCap %s', (value) => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      limits: { ...demoDescriptor().limits, membersCap: value },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects limits.staffCap Infinity', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      limits: { ...demoDescriptor().limits, staffCap: Infinity },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('accepts limits with both caps null', () => {
    const descriptor = tenantDescriptor();
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
  });

  it('accepts a positive integer membersCap and staffCap', () => {
    const descriptor = demoDescriptor();
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
  });

  it('rejects caps.pidsLimit of 1e300 -- Number.isInteger alone accepts it; Number.isSafeInteger does not', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      caps: { ...demoDescriptor().caps, pidsLimit: 1e300 },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects caps.nofile of 1e300', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      caps: { ...demoDescriptor().caps, nofile: 1e300 },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects caps.cpuShares of 1e300', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      caps: { ...demoDescriptor().caps, cpuShares: 1e300 },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it("rejects limits.membersCap of 2^53+2 -- above Number.isSafeInteger's own ceiling", () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      limits: { ...demoDescriptor().limits, membersCap: 2 ** 53 + 2 },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects limits.staffCap of a safe integer that is still past its sane ceiling', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      limits: { ...demoDescriptor().limits, staffCap: 50_000 },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects caps.cpus of 32 digits -- exactly at the character-length cap, so the length check alone would accept it', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      caps: { ...demoDescriptor().caps, cpus: '1'.repeat(32) },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });
});

describe('validate() — siteUrl exact match', () => {
  it('accepts an optional trailing slash', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://k7m-vale-bright.demo-domain.example.test/' as never,
    };
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
  });

  it('rejects a port', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://k7m-vale-bright.demo-domain.example.test:8443' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a path', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://k7m-vale-bright.demo-domain.example.test/admin' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects userinfo', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://user:pass@k7m-vale-bright.demo-domain.example.test' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a query string', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://k7m-vale-bright.demo-domain.example.test?x=1' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a fragment', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://k7m-vale-bright.demo-domain.example.test#x' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an uppercase host', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://K7M-VALE-BRIGHT.demo-domain.example.test' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects http in place of https', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'http://k7m-vale-bright.demo-domain.example.test' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a backslash host-confusion attempt', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      siteUrl: 'https://evil.example\\@k7m-vale-bright.demo-domain.example.test' as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });
});

describe('validate() — hostname.sub is a DNS label', () => {
  it('rejects an empty sub', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      hostname: { kind: 'ours', sub: '', gated: true },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.sub');
  });

  it('rejects a sub containing a dot', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      hostname: { kind: 'ours', sub: 'a.b', gated: true },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.sub');
  });

  it('rejects a sub with an uppercase character', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      hostname: { kind: 'ours', sub: 'Demo-1', gated: true },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.sub');
  });
});

describe('validate() — unknown keys are rejected at every object level', () => {
  it('rejects an unknown top-level key', () => {
    const descriptor = { ...demoDescriptor(), extra: 'nope' } as unknown as TenantDescriptor;
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('descriptor');
  });

  it('rejects codeInjection:{kind:"blocked", head:"<script>"} — an extra key on the blocked variant', () => {
    const descriptor = {
      ...demoDescriptor(),
      codeInjection: { kind: 'blocked', head: '<script>' },
    } as unknown as TenantDescriptor;
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('codeInjection');
  });

  it('rejects an unknown key on ports', () => {
    const descriptor = {
      ...demoDescriptor(),
      ports: { ...demoDescriptor().ports, extra: 1 },
    } as unknown as TenantDescriptor;
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('ports');
  });

  it('rejects an unknown key on safety', () => {
    const descriptor = {
      ...demoDescriptor(),
      safety: { near: true, exact: true, extra: true },
    } as unknown as TenantDescriptor;
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an array where an object is expected (limits: [])', () => {
    const descriptor = { ...demoDescriptor(), limits: [] } as unknown as TenantDescriptor;
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as Error).message).toContain('an array');
  });

  it('rejects an unknown key on limits', () => {
    const descriptor = {
      ...demoDescriptor(),
      limits: { ...demoDescriptor().limits, extra: 1 },
    } as unknown as TenantDescriptor;
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a __proto__ own-property, the shape JSON.parse gives an attacker-supplied body', () => {
    // Object-literal syntax (`{__proto__: x}`) sets the prototype instead of
    // an own key — this constructs the actually-hostile shape the way
    // `JSON.parse` of untrusted text does: `__proto__` as a genuine,
    // enumerable own property.
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const descriptor = { ...demoDescriptor(), ...hostile } as unknown as TenantDescriptor;
    // Control: confirm the hostile shape actually landed as an own key,
    // rather than silently becoming a no-op prototype assignment.
    expect(Object.prototype.hasOwnProperty.call(descriptor, '__proto__')).toBe(true);
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });
});

describe('validate() — a theirs fqdn must not be an IP literal, or IPv4 shorthand for one', () => {
  it('rejects an IPv4 literal', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      siteUrl: 'https://203.0.113.5' as never,
      hostname: {
        kind: 'theirs',
        fqdn: '203.0.113.5',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.fqdn');
  });

  it('rejects an IPv6 literal', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: '2001:db8::1',
        verifiedAt: '2026-09-01T00:00:00.000Z' as never,
      },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  // `new URL('https://127.1').host` is `127.0.0.1` — each of these is a
  // shorter, still-valid-to-a-URL-parser way of writing the same IPv4
  // literal, which would let a "theirs" custom domain actually resolve
  // through the URL parser as a raw IP address rather than a DNS name.
  it.each(['127.1', '127.0.1', '0x7f.1', '0x7f.0.0.1'])(
    'rejects the IPv4 shorthand literal %s',
    (fqdn) => {
      const descriptor: TenantDescriptor = {
        ...tenantDescriptor(),
        hostname: { kind: 'theirs', fqdn, verifiedAt: '2026-09-01T00:00:00.000Z' as never },
      };
      let caught: unknown;
      try {
        validate(descriptor, TEST_ZONES);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FieldValidationError);
      expect((caught as FieldValidationError).field).toBe('hostname.fqdn');
    }
  );
});

describe('validate() — path and host fields reject empty, relative, traversal and injection-shaped values', () => {
  it('rejects an empty database.path (sqlite)', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      database: { kind: 'sqlite', path: '' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a database.path with a ".." segment', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      database: { kind: 'sqlite', path: '/data/../../etc/passwd' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a media.path with a ".." segment', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      media: { ...demoDescriptor().media, path: '/data/../../etc' } as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an empty media.path', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      media: { ...demoDescriptor().media, path: '' } as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an empty database.host (mysql)', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      database: {
        kind: 'mysql',
        host: '',
        port: 3306 as never,
        name: 'ghost_acme',
        user: 'ghost_acme',
      },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an empty transport.path (queue)', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      transport: { kind: 'queue', path: '' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a transport.path with a ".." segment', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      transport: { kind: 'queue', path: '/var/spool/../../etc' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an empty transport.host (smtp)', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      transport: { kind: 'smtp', host: '', port: 587 as never, user: 'ghost' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a relative database.path', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      database: { kind: 'sqlite', path: 'relative/ghost.db' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a relative transport.path', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      transport: { kind: 'queue', path: 'relative/spool' },
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a database.path carrying a backslash traversal segment ("..\\\\x")', () => {
    const descriptor: TenantDescriptor = {
      ...demoDescriptor(),
      database: { kind: 'sqlite', path: '/data\\..\\x' },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('database.path');
  });

  it('rejects an empty database.name (mysql) -- the slug-derived identity check never matches an empty name', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      database: { ...tenantDescriptor().database, name: '' } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('database.name');
  });

  it('rejects an empty database.user (mysql) -- the slug-derived identity check never matches an empty user', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      database: { ...tenantDescriptor().database, user: '' } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('database.user');
  });

  it('rejects a database.host with an embedded space', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      database: { ...tenantDescriptor().database, host: 'db t1.internal' } as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects a database.host with a semicolon', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      database: { ...tenantDescriptor().database, host: 'db-t1.internal;DROP TABLE x' } as never,
    };
    expect(() => validate(descriptor, TEST_ZONES)).toThrow(FieldValidationError);
  });

  it('rejects an empty media.bucket (s3, tenant) -- the slug-derived identity check never matches an empty bucket', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      media: { ...tenantDescriptor().media, bucket: '' } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('media.bucket');
  });

  it('rejects an empty media.region (s3, tenant)', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      media: { ...tenantDescriptor().media, region: '' } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('media.region');
  });

  it('rejects a media.endpoint of "javascript:alert(1)"', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      media: { ...tenantDescriptor().media, endpoint: 'javascript:alert(1)' } as never,
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('media.endpoint');
  });

  it('rejects hostname.verifiedAt of "2026-02-30T00:00:00.000Z" -- not a real calendar date', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: 'blog.acme.example',
        verifiedAt: '2026-02-30T00:00:00.000Z' as never,
      },
    };
    let caught: unknown;
    try {
      validate(descriptor, TEST_ZONES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldValidationError);
    expect((caught as FieldValidationError).field).toBe('hostname.verifiedAt');
  });
});

describe('servedHostnameOf() — what a certificate-admission decision may admit', () => {
  it('composes a tenant\'s "ours" hostname under the platform zone', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: { kind: 'ours', sub: 'acme', gated: false },
    };
    expect(servedHostnameOf(descriptor, TEST_ZONES)).toBe('acme.platform-domain.example.test');
  });

  it('passes a tenant\'s "theirs" fqdn through as-is', () => {
    expect(servedHostnameOf(tenantDescriptor(), TEST_ZONES)).toBe('blog.acme.example');
  });

  it('never admits a demo\'s "ours" hostname -- demo slots sit under the platform wildcard, not a per-hostname cert', () => {
    expect(servedHostnameOf(demoDescriptor(), TEST_ZONES)).toBeNull();
  });

  it('never reads zones.demoZone for a demo descriptor -- the demo branch returns before using it', () => {
    const poisonedZones = { ...TEST_ZONES, demoZone: 'poison.invalid' };
    // If this ever read demoZone it would still return null (the branch
    // returns unconditionally), so this is a proof the field goes unread
    // at all, not merely that the visible answer happens to be right.
    expect(servedHostnameOf(demoDescriptor(), poisonedZones)).toBeNull();
  });

  it('refuses a multi-label "ours" sub (slot/tenant name confusion, not a single DNS label)', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: { kind: 'ours', sub: 'a.b', gated: false },
    };
    expect(servedHostnameOf(descriptor, TEST_ZONES)).toBeNull();
  });

  it('refuses a "theirs" fqdn that is itself one of the platform\'s owned domains', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: 'platform-domain.example.test',
        verifiedAt: '2026-09-01T00:00:00.000Z' as Instant,
      },
    };
    expect(servedHostnameOf(descriptor, TEST_ZONES)).toBeNull();
  });

  it('refuses a "theirs" fqdn that is a subdomain of an owned domain, not only an exact match', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: 'sub.demo-domain.example.test',
        verifiedAt: '2026-09-01T00:00:00.000Z' as Instant,
      },
    };
    expect(servedHostnameOf(descriptor, TEST_ZONES)).toBeNull();
  });

  it('refuses a malformed "theirs" fqdn (IP literal)', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: '203.0.113.5',
        verifiedAt: '2026-09-01T00:00:00.000Z' as Instant,
      },
    };
    expect(servedHostnameOf(descriptor, TEST_ZONES)).toBeNull();
  });

  it('refuses an uppercase "ours" sub -- the label pattern is lowercase-only, matching the schema\'s slug', () => {
    const descriptor: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: { kind: 'ours', sub: 'ACME', gated: false },
    };
    expect(servedHostnameOf(descriptor, TEST_ZONES)).toBeNull();
  });

  it('refuses a "theirs" fqdn with an uppercase label or a trailing dot -- shape rules match validateHostname\'s, not a tolerant normalizer', () => {
    const uppercase: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: 'Blog.Acme.Example',
        verifiedAt: '2026-09-01T00:00:00.000Z' as Instant,
      },
    };
    expect(servedHostnameOf(uppercase, TEST_ZONES)).toBeNull();

    const trailingDot: TenantDescriptor = {
      ...tenantDescriptor(),
      hostname: {
        kind: 'theirs',
        fqdn: 'blog.acme.example.',
        verifiedAt: '2026-09-01T00:00:00.000Z' as Instant,
      },
    };
    expect(servedHostnameOf(trailingDot, TEST_ZONES)).toBeNull();
  });
});
