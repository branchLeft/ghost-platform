import { afterEach, describe, expect, it, vi } from 'vitest';

// Sabotage proofs, run in CI: each test replaces one mechanism with a version
// that does nothing, and shows the refusal the other tests assert is gone. A
// refusal that survives its mechanism being removed would be coming from
// somewhere else, and those tests would prove nothing. Each case runs the real
// mechanism first (the control), then the sabotaged one, on the same input.

const SENDER = 'demo-mail.example.test';

afterEach(() => {
  vi.doUnmock('../../src/crypto.js');
  vi.doUnmock('../../src/localPartBinding.js');
  vi.resetModules();
});

describe('sabotage: the key check is keyMatchesSync', () => {
  async function registerSecondCredentialWithSameKey(): Promise<'refused' | 'registered'> {
    const { createSqliteStore, TenantRegistrationRefused } = await import('../../src/store.js');
    const store = createSqliteStore(':memory:');
    try {
      store.registerTenant(`slot-30001.${SENDER}`, 'shared-test-key', SENDER, 'demo-1');
      try {
        store.registerTenant(`slot-30002.${SENDER}`, 'shared-test-key', SENDER, 'demo-2');
        return 'registered';
      } catch (err) {
        if (err instanceof TenantRegistrationRefused) return 'refused';
        throw err;
      }
    } finally {
      store.close();
    }
  }

  it('refuses a shared key with the real keyMatchesSync, and registers it when keyMatchesSync matches nothing', async () => {
    await expect(registerSecondCredentialWithSameKey()).resolves.toBe('refused');

    vi.resetModules();
    vi.doMock('../../src/crypto.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/crypto.js')>()),
      keyMatchesSync: () => false,
    }));

    await expect(registerSecondCredentialWithSameKey()).resolves.toBe('registered');
  });
});

describe('sabotage: the local part binding is localPartDiffers', () => {
  async function otherSlotsAddress(): Promise<string | null> {
    const { boundSender, senderBelongsToTenant } = await import('../../src/senderAuthorization.js');
    const other = `demo-2@${SENDER}`;
    // Both entry points use the one comparison; they must agree.
    const viaBound = boundSender(other, SENDER, undefined, 'demo-1');
    const viaBelongs = senderBelongsToTenant(other, SENDER, 'demo-1');
    expect(viaBelongs).toBe(viaBound !== null);
    return viaBound;
  }

  it("refuses another slot's address with the real localPartDiffers, and accepts it when localPartDiffers never differs", async () => {
    await expect(otherSlotsAddress()).resolves.toBeNull();

    vi.resetModules();
    vi.doMock('../../src/localPartBinding.js', () => ({ localPartDiffers: () => false }));

    await expect(otherSlotsAddress()).resolves.toBe(`demo-2@${SENDER}`);
  });
});
