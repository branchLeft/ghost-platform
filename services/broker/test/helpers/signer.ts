import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { signRequest } from '../../src/signing.js';

export interface TestKeyPair {
  readonly publicKeyRaw: Buffer;
  readonly privateKeyRaw: Buffer;
}

export function generateTestKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyRaw: publicKey.export({ format: 'der', type: 'spki' }).subarray(12),
    privateKeyRaw: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16),
  };
}

/** Builds the three signed-request headers `auth.ts`/`app.ts` read. */
export function signHeaders(
  keyPair: TestKeyPair,
  method: string,
  path: string,
  rawBody: Buffer,
  nowSeconds: number,
  nonce = randomBytes(16).toString('hex')
): { 'X-Broker-Timestamp': string; 'X-Broker-Nonce': string; 'X-Broker-Signature': string } {
  const timestamp = String(nowSeconds);
  const signature = signRequest(keyPair.privateKeyRaw, method, path, timestamp, nonce, rawBody);
  return {
    'X-Broker-Timestamp': timestamp,
    'X-Broker-Nonce': nonce,
    'X-Broker-Signature': signature,
  };
}
