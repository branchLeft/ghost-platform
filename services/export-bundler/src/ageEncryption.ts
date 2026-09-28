import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';

/**
 * The archive is encrypted the way a tenant's backups are (LLD-9 §02,
 * `infra/provisioning/scripts/pull_encrypt_store.py`): `age` to the
 * tenant's one recipient, plaintext handed to `age` on stdin and never
 * written anywhere, and the ciphertext's own header re-read afterwards to
 * confirm it names exactly one recipient. A second recipient would leave
 * the archive readable after the tenant's key is destroyed, which is the
 * crypto-shredding property LLD-9 exists to hold.
 */

export class InvalidAgeRecipientError extends Error {
  constructor() {
    super(
      'the age recipient must be one X25519 public key (age1 followed by 58 bech32 characters)'
    );
    this.name = 'InvalidAgeRecipientError';
  }
}

export class AgeEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgeEncryptionError';
  }
}

// Only the X25519 form: it is the form the backup recipients take, and the
// bech32 alphabet excludes 1, b, i and o.
const AGE_X25519_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

export function assertAgeRecipient(recipient: string): void {
  if (!AGE_X25519_RECIPIENT.test(recipient)) throw new InvalidAgeRecipientError();
}

/** What the manifest and the audit record name the recipient by. */
export function recipientFingerprint(recipient: string): string {
  return `sha256:${createHash('sha256').update(recipient, 'ascii').digest('hex')}`;
}

/**
 * Counts `-> ` stanza lines up to the header's closing `---` line, the same
 * structural read as `count_age_recipient_stanzas` in
 * `infra/provisioning/scripts/media_backup_restore.py`.
 */
export function countAgeRecipientStanzas(ciphertext: Buffer): number {
  let count = 0;
  let start = 0;
  while (start < ciphertext.length) {
    let end = ciphertext.indexOf(0x0a, start);
    if (end === -1) end = ciphertext.length;
    const line = ciphertext.subarray(start, end);
    if (line.length >= 3 && line.subarray(0, 3).toString('latin1') === '---') break;
    if (line.subarray(0, 3).toString('latin1') === '-> ') count += 1;
    start = end + 1;
  }
  return count;
}

// The header is textual and bounded; one X25519 stanza is well under 1 KiB.
const HEADER_READ_BYTES = 16 * 1024;

/**
 * Encrypts `plaintext` to `recipient` into a new file at `destPath`, created
 * 0600 and exclusively (an existing file is never overwritten). `plaintext`
 * reaches `age` only through its stdin pipe. On any failure the destination
 * is removed, so a half-written or unverified ciphertext is never left
 * behind for someone to hand over.
 */
export async function encryptToFile(
  plaintext: Buffer,
  recipient: string,
  destPath: string,
  ageCommand = 'age'
): Promise<void> {
  assertAgeRecipient(recipient);
  const handle = await open(destPath, 'wx+', 0o600);
  let ok = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ageCommand, ['-r', recipient], {
        // PATH only: never the ambient environment, which carries live
        // credentials this child has no use for.
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['pipe', handle.fd, 'pipe'],
      });
      const { stdin, stderr: stderrStream } = child as typeof child & {
        stdin: NonNullable<typeof child.stdin>;
        stderr: NonNullable<typeof child.stderr>;
      };
      const stderr: Buffer[] = [];
      stderrStream.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (err) =>
        reject(new AgeEncryptionError(`age did not start: ${err.message}`))
      );
      child.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new AgeEncryptionError(`age exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`)
          );
      });
      // An early exit closes the pipe; the close handler above reports it.
      stdin.on('error', () => undefined);
      stdin.end(plaintext);
    });
    const header = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(header, 0, HEADER_READ_BYTES, 0);
    const stanzas = countAgeRecipientStanzas(header.subarray(0, bytesRead));
    if (stanzas !== 1) {
      throw new AgeEncryptionError(
        `the archive's age header names ${stanzas} recipient(s), expected exactly 1`
      );
    }
    ok = true;
  } finally {
    await handle.close();
    if (!ok) await rm(destPath, { force: true });
  }
}
