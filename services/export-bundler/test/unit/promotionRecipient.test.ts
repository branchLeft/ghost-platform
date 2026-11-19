import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeEncryptedArchive } from '../../src/archive.js';
import { countAgeRecipientStanzas } from '../../src/ageEncryption.js';
import {
  bindTenant,
  parseComposeConfig,
  parseDescriptorFacts,
  RecipientMismatchError,
  SUPPORT_IDENTITY_ENV,
  TenantConfigError,
} from '../../src/tenantConfig.js';
import { decryptAge, generateAgeIdentity, type AgeIdentity } from '../helpers/age.js';

/**
 * A demo has no backup recipient, so a promotion supplies one. These tests
 * run the two halves together, the way the CLI does: the descriptor and the
 * rendered stack are bound to a recipient, and only what that returns
 * reaches the archive writer. Whatever the binding refuses, nothing is
 * written at all; whatever it accepts is readable by the promotion's key
 * and by no other.
 */
const demoDescriptor = { slug: 'demo-one', backup: { kind: 'none' } };
const stack = parseComposeConfig({
  name: 'demo-one',
  services: {
    'ghost-a': {
      image: 'ghost-platform@sha256:abc',
      environment: {
        adapters__sso__BreakGlassSSO__tenant: 'demo-one',
        [SUPPORT_IDENTITY_ENV]: 'support@demo-one.example',
      },
      volumes: [{ type: 'volume', source: 'ghost-demo-one-content', target: '/content' }],
    },
  },
});

describe('a demo export bound to a promotion recipient', () => {
  let keyDir: string;
  let outDir: string;
  let promotion: AgeIdentity;
  let tenantsOwn: AgeIdentity;
  let attacker: AgeIdentity;

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'export-bundler-promotion-keys-'));
    outDir = await mkdtemp(join(tmpdir(), 'export-bundler-promotion-out-'));
    // age-keygen writes `identity.txt` into the directory it is given.
    promotion = generateAgeIdentity(await mkdtemp(join(keyDir, 'promotion-')));
    tenantsOwn = generateAgeIdentity(await mkdtemp(join(keyDir, 'tenant-')));
    attacker = generateAgeIdentity(await mkdtemp(join(keyDir, 'other-')));
  });

  afterAll(async () => {
    await rm(keyDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  const files = [{ name: 'content_and_settings.json', data: 'PROMOTION-PLAINTEXT-marker' }];

  it('is encrypted to the promotion recipient only: its identity opens it and no other key does', async () => {
    const recipient = bindTenant(parseDescriptorFacts(demoDescriptor), stack, promotion.recipient, {
      recipient: promotion.recipient,
      grantLane: 'consented',
    });
    const archive = join(outDir, 'demo.tar.age');
    await writeEncryptedArchive(archive, files, 1, recipient);

    expect(decryptAge(archive, promotion.identityPath).toString('latin1')).toContain(
      'content_and_settings.json'
    );
    expect(() => decryptAge(archive, tenantsOwn.identityPath)).toThrow();
    expect(() => decryptAge(archive, attacker.identityPath)).toThrow();
    // One stanza, so no second key is hidden in the header either.
    expect(countAgeRecipientStanzas(await readFile(archive))).toBe(1);
    // And the plaintext is nowhere in the file.
    expect((await readFile(archive)).includes(Buffer.from('PROMOTION-PLAINTEXT-marker'))).toBe(
      false
    );
  });

  const secretHalf = 'AGE-SECRET-KEY-1' + 'Q'.repeat(58);
  const consented = (recipient: string) => ({ recipient, grantLane: 'consented' as const });

  /** What the CLI does: bind, then write only what the binding returned. */
  async function bindThenWrite(
    descriptor: unknown,
    operatorRecipient: string,
    promotionRecipient: { recipient: string; grantLane: 'consented' | 'incident' } | null
  ): Promise<void> {
    const recipient = bindTenant(
      parseDescriptorFacts(descriptor),
      stack,
      operatorRecipient,
      promotionRecipient
    );
    await writeEncryptedArchive(join(outDir, 'refused.tar.age'), files, 1, recipient);
  }

  it.each([
    ['no promotion recipient', () => bindThenWrite(demoDescriptor, promotion.recipient, null)],
    [
      'an operator recipient that is not the promotion recipient',
      () => bindThenWrite(demoDescriptor, attacker.recipient, consented(promotion.recipient)),
    ],
    [
      'the incident lane',
      () =>
        bindThenWrite(demoDescriptor, promotion.recipient, {
          recipient: promotion.recipient,
          grantLane: 'incident',
        }),
    ],
    [
      "a tenant's own backup recipient being replaced",
      () =>
        bindThenWrite(
          {
            slug: 'demo-one',
            backup: { kind: 'bucket-native', encryptionRecipient: tenantsOwn.recipient },
          },
          promotion.recipient,
          consented(promotion.recipient)
        ),
    ],
    [
      'a private half given as the recipient',
      () => bindThenWrite(demoDescriptor, secretHalf, consented(secretHalf)),
    ],
  ])('refuses %s, and no archive is written', async (_label, run) => {
    const before = await readdir(outDir);
    const raised = await run().then(
      () => undefined,
      (err: unknown) => err
    );
    expect(raised).toSatisfy(
      (e: unknown) => e instanceof TenantConfigError || e instanceof RecipientMismatchError
    );
    expect(await readdir(outDir)).toEqual(before);
  });
});
