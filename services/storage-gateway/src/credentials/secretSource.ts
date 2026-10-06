import type { SigningSecretSource } from '../contracts.js';
import { deriveTenantSecret, isValidKeyId } from './derive.js';
import type { MasterSecret } from './masterSecret.js';
import type { SqliteCredentialStore } from './store.js';

/**
 * The signature check's source of tenant secrets. A secret is derived only
 * for a key id the store issued and still holds as active; every other key
 * id, including a malformed one, resolves to `undefined`, so the signature
 * check refuses it as an unknown key.
 */
export function createSigningSecretSource(
  store: Pick<SqliteCredentialStore, 'get'>,
  master: MasterSecret
): SigningSecretSource {
  return {
    signingSecret(keyId) {
      if (!isValidKeyId(keyId)) return Promise.resolve(undefined);
      const credential = store.get(keyId);
      if (credential?.state !== 'active') return Promise.resolve(undefined);
      return Promise.resolve(deriveTenantSecret(master, keyId));
    },
  };
}
