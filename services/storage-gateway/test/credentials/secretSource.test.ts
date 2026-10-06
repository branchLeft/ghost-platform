import { describe, expect, it } from 'vitest';
import { deriveTenantSecret } from '../../src/credentials/derive.js';
import { MasterSecret } from '../../src/credentials/masterSecret.js';
import { createSigningSecretSource } from '../../src/credentials/secretSource.js';
import type { StoredCredential } from '../../src/credentials/store.js';

const MASTER = MasterSecret.fromBytes(Buffer.alloc(32, 7));
const ACTIVE = 'GWACTIVE000000000000000000';
const DISABLED = 'GWDISABLED0000000000000000';
const REVOKED = 'GWREVOKED00000000000000000';

const rows: Record<string, StoredCredential> = {
  [ACTIVE]: {
    keyId: ACTIVE,
    folder: 'f'.repeat(16),
    bucket: 'shard-one',
    state: 'active',
    createdAt: 'x',
  },
  [DISABLED]: {
    keyId: DISABLED,
    folder: 'g'.repeat(16),
    bucket: 'shard-one',
    state: 'disabled',
    createdAt: 'x',
  },
  [REVOKED]: {
    keyId: REVOKED,
    folder: 'h'.repeat(16),
    bucket: 'shard-one',
    state: 'revoked',
    createdAt: 'x',
  },
};
const source = createSigningSecretSource({ get: (keyId) => rows[keyId] }, MASTER);

describe('createSigningSecretSource', () => {
  it('derives the secret for an active key id', async () => {
    await expect(source.signingSecret(ACTIVE)).resolves.toBe(deriveTenantSecret(MASTER, ACTIVE));
  });

  it.each([
    ['disabled', DISABLED],
    ['revoked', REVOKED],
    ['never issued', 'GWNEVERISSUED0000000000000'],
    ['malformed', 'gw-not-a-key'],
  ])('gives no secret for a %s key id', async (_label, keyId) => {
    await expect(source.signingSecret(keyId)).resolves.toBeUndefined();
  });
});
