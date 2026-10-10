import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface PendingLogin {
  /** The PKCE verifier; only the challenge derived from it leaves the server. */
  readonly verifier: string;
  readonly state: string;
  /** Seconds since the epoch. */
  readonly expiresAt: number;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
// Neither the verifier nor the state can hold a dot: both are URL-safe.
const SEPARATOR = '.';

/**
 * Seals a pending sign-in into the value the browser carries, so beginning one
 * holds nothing on the server and no number of unauthenticated starts can use
 * up room a real sign-in needs. The key lives in this process alone: a restart
 * drops pending sign-ins, exactly as the in-memory store this replaces did.
 */
export class PendingLoginSealer {
  readonly #key = randomBytes(32);

  seal(login: PendingLogin): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: TAG_BYTES });
    const plain = [login.verifier, login.state, String(login.expiresAt)].join(SEPARATOR);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('hex');
  }

  /** The pending sign-in, or null for a value that is forged, foreign, malformed or expired. */
  open(sealed: string | undefined, now: number): PendingLogin | null {
    if (sealed === undefined || !/^(?:[0-9a-f]{2})+$/.test(sealed)) return null;
    const raw = Buffer.from(sealed, 'hex');
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    let plain: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const body = raw.subarray(IV_BYTES + TAG_BYTES);
      plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
    const [verifier, state, expiry, ...extra] = plain.split(SEPARATOR);
    const expiresAt = Number(expiry);
    if (!verifier || !state || extra.length > 0) return null;
    if (!Number.isInteger(expiresAt) || expiresAt <= now) return null;
    return { verifier, state, expiresAt };
  }
}
