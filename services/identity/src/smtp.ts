import { scryptSync } from 'node:crypto';
import { fstatSync, openSync, readSync, closeSync, constants } from 'node:fs';
import type { SmtpConfig } from './config.js';
import { ConfigError } from './errors.js';

/** Marks the mail provider this reconciler owns. It is how the reconciler
 * finds its own provider among the instance's, and how it tells one an
 * operator added by hand (which it never replaces or deletes). */
export const MANAGED_MARK = 'branchleft-managed';

const MAX_PASSWORD_LENGTH = 256;

/** Reads the mail password from a file, never from argv or the environment.
 * The file must be a plain file closed to everyone but its owner and group,
 * is opened without following a link, and its content is never echoed: every
 * refusal names the file and the rule, not what was in it. One trailing line
 * ending is removed; anything else that is not printable ASCII, or an empty
 * or over-long value, is refused. */
export function readSmtpPassword(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ConfigError([`the SMTP password file ${path} cannot be opened`]);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile())
      throw new ConfigError([`the SMTP password file ${path} is not a plain file`]);
    if ((info.mode & 0o007) !== 0) {
      throw new ConfigError([
        `the SMTP password file ${path} is readable by everyone; close it to other users`,
      ]);
    }
    if (info.size > MAX_PASSWORD_LENGTH + 2) {
      throw new ConfigError([
        `the SMTP password file ${path} is longer than ${MAX_PASSWORD_LENGTH} characters`,
      ]);
    }
    const buffer = Buffer.alloc(Math.max(info.size, 1));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    let text = buffer.subarray(0, read).toString('latin1');
    if (text.endsWith('\r\n')) text = text.slice(0, -2);
    else if (text.endsWith('\n')) text = text.slice(0, -1);
    if (text.length === 0) throw new ConfigError([`the SMTP password file ${path} is empty`]);
    if (!/^[\x21-\x7e]+$/.test(text)) {
      throw new ConfigError([
        `the SMTP password file ${path} must hold printable ASCII with no spaces or line breaks`,
      ]);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

/** A short digest of every setting that makes a provider what it is, the
 * password included. Zitadel never returns a stored password, so this is how a
 * changed password is noticed: it is written into the provider's description,
 * and a mismatch with the wanted value means "replace". The password goes
 * through scrypt (a deliberately slow key derivation) with the settings as its
 * salt, so the digest is neither a bare hash of the password nor reusable
 * across two providers, and guessing the password from it costs real work. */
export function smtpFingerprint(smtp: SmtpConfig, password: string): string {
  const salt = JSON.stringify([
    'branchleft-zitadel-smtp-v1',
    smtp.host,
    smtp.port,
    smtp.senderAddress,
    smtp.senderName,
    smtp.tls,
  ]);
  return scryptSync(password, salt, 16).toString('hex');
}

export function smtpDescription(smtp: SmtpConfig, password: string): string {
  return `${MANAGED_MARK} ${smtpFingerprint(smtp, password)}`;
}

export function isManaged(description: string): boolean {
  return description === MANAGED_MARK || description.startsWith(`${MANAGED_MARK} `);
}
