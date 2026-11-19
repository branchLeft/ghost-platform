import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';

export interface MintClaims {
  sub: string;
  aud: string;
  host: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface TestKeyPair {
  readonly privateKey: KeyObject;
  /** Base64 SPKI DER, the form the adapter's configuration and the gate's key file hold. */
  readonly publicKeyBase64: string;
}

export function generateKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

/** The portal's side, as the adapter's README specifies the envelope. */
export function mintRaw(privateKey: KeyObject, body: string): string {
  const encoded = Buffer.from(body, 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(encoded, 'ascii'), privateKey).toString('base64url');
  return `${encoded}.${signature}`;
}

export function mintInvitation(
  privateKey: KeyObject,
  claims: Partial<MintClaims> & Pick<MintClaims, 'host'>,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const full: MintClaims = {
    sub: 'owner@example.test',
    aud: 'demo-slug',
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: randomUUID(),
    ...claims,
  };
  return mintRaw(privateKey, JSON.stringify(full));
}
