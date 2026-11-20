/**
 * A demo's passphrase and the argon2id hash its descriptor carries. The
 * passphrase is returned once, to the caller that sends the arrival mail, and
 * is held nowhere here; the hash is what reaches the host. The hash is the
 * demo gate's own PHC form (`services/demo-gate/src/argon2id.ts`), so the gate
 * verifies exactly what this mints. See controlPlaneDemoDescriptor.md.
 */
import { argon2, randomBytes } from 'node:crypto';

export interface IssuedGate {
  /** Shown to the prospect once. Never logged, never stored. */
  readonly passphrase: string;
  readonly argon2idHash: string;
}

/** A new passphrase and its hash. The seam for a test; production uses `issueDemoGate`. */
export interface GateIssuer {
  issue(): Promise<IssuedGate>;
}

/** RFC 9106's second recommended option, the parameters the demo gate mints with. */
export const GATE_PARAMETERS = { memoryKiB: 64 * 1024, passes: 3, parallelism: 4 } as const;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const GROUPS = 4;
const GROUP_LENGTH = 5;

/** 20 letters of base32, 100 bits, in four dash-separated groups: the low five bits of a byte pick a letter, uniformly. */
export function newPassphrase(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(GROUPS * GROUP_LENGTH);
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group++) {
    let text = '';
    for (let index = 0; index < GROUP_LENGTH; index++) {
      text += ALPHABET.charAt((bytes[group * GROUP_LENGTH + index] as number) & 31);
    }
    groups.push(text);
  }
  return groups.join('-');
}

function encodeUnpadded(value: Buffer): string {
  return value.toString('base64').replace(/=+$/, '');
}

function derive(message: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message,
        nonce: salt,
        parallelism: GATE_PARAMETERS.parallelism,
        tagLength: 32,
        memory: GATE_PARAMETERS.memoryKiB,
        passes: GATE_PARAMETERS.passes,
      },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

/** The PHC string for `passphrase`, with a fresh 16-byte salt. */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const tag = await derive(Buffer.from(passphrase, 'utf8'), salt);
  const { memoryKiB: m, passes: t, parallelism: p } = GATE_PARAMETERS;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${encodeUnpadded(salt)}$${encodeUnpadded(tag)}`;
}

export const issueDemoGate: GateIssuer = {
  async issue() {
    const passphrase = newPassphrase();
    return { passphrase, argon2idHash: await hashPassphrase(passphrase) };
  },
};
