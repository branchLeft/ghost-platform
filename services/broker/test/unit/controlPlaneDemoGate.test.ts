import { argon2Sync, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GATE_PARAMETERS,
  hashPassphrase,
  issueDemoGate,
  newPassphrase,
} from '../../src/controlPlaneDemoGate.js';

const PHC = /^\$argon2id\$v=19\$m=65536,t=3,p=4\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

describe('newPassphrase', () => {
  it('is 20 base32 letters in four groups, from the random source', () => {
    expect(newPassphrase(() => new Uint8Array(20))).toBe('aaaaa-aaaaa-aaaaa-aaaaa');
    expect(newPassphrase(() => new Uint8Array(20).fill(31))).toBe('77777-77777-77777-77777');
    expect(newPassphrase()).toMatch(/^[a-z2-7]{5}(-[a-z2-7]{5}){3}$/);
  });

  it('draws only the low five bits of each byte, so every letter is equally likely', () => {
    // 0xe0 | 5 and 5 are the same letter.
    expect(newPassphrase(() => new Uint8Array(20).fill(0xe5))).toBe(
      newPassphrase(() => new Uint8Array(20).fill(5))
    );
  });
});

describe('hashPassphrase and issueDemoGate', () => {
  it("mints the demo gate's PHC form, and the tag is the argon2id of the passphrase under that salt", async () => {
    const phc = await hashPassphrase('correct-horse');
    const match = PHC.exec(phc);
    expect(match).not.toBeNull();
    const salt = Buffer.from(match![1] as string, 'base64');
    const tag = Buffer.from(match![2] as string, 'base64');
    const expected = argon2Sync('argon2id', {
      message: Buffer.from('correct-horse'),
      nonce: salt,
      parallelism: GATE_PARAMETERS.parallelism,
      tagLength: 32,
      memory: GATE_PARAMETERS.memoryKiB,
      passes: GATE_PARAMETERS.passes,
    });
    expect(timingSafeEqual(expected, tag)).toBe(true);
  });

  it('issues a fresh passphrase and a fresh salt every time, and the hash does not contain the passphrase', async () => {
    const first = await issueDemoGate.issue();
    const second = await issueDemoGate.issue();
    expect(first.passphrase).not.toBe(second.passphrase);
    expect(first.argon2idHash).not.toBe(second.argon2idHash);
    expect(first.argon2idHash).toMatch(PHC);
    expect(first.argon2idHash).not.toContain(first.passphrase);
  });
});
