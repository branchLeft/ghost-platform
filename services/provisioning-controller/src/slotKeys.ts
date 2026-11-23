import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PermanentStepError } from './errors.js';

/**
 * The slot's deploy key pair, made by the controller and by nothing else. `ensure` makes the pair
 * the first time a slot is asked for and never again: the public half is sent once by the host's
 * `key` verb, and a second pair would leave the host holding a key the controller no longer has.
 *
 * - The private half is an unencrypted OpenSSH ed25519 key, written exclusively (a file already
 *   there is never overwritten) with mode 0600 in a directory made 0700. Nothing in the controller
 *   reads it but the first-deploy step, which hands its path to `ssh -i`; it is never returned as
 *   text, put in a plan, a record, a report or an error.
 * - The public half is one `ssh-ed25519 BASE64` line with no comment, the shape the host's `key`
 *   verb accepts.
 * - Files are named by the slot, which is checked as the register's slot pattern, so a slot cannot
 *   name a path.
 */
export interface SlotKeys {
  /** Makes the slot's pair if there is none. Safe to call again: it changes nothing. */
  ensure(slot: string): Promise<void>;
  /** The public half; refused (permanent) when the pair was never made. */
  publicKey(slot: string): Promise<string>;
  /** Where the private half is, for `ssh -i`; refused (permanent) when the pair was never made. */
  privateKeyPath(slot: string): Promise<string>;
}

const SLOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEY_TYPE = 'ssh-ed25519';
const ED25519_PUBLIC_BYTES = 32;
const ED25519_SEED_BYTES = 32;
const OPENSSH_MAGIC = 'openssh-key-v1\0';
const BLOCK = 8;

const sshString = (data: Buffer | string): Buffer => {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

const uint32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** The raw 32 bytes at the end of a DER-encoded ed25519 key (SPKI and PKCS8 both end in the key). */
const tail = (der: Buffer, bytes: number): Buffer => der.subarray(der.length - bytes);

export interface OpenSshPair {
  /** `ssh-ed25519 BASE64`, one line, no comment. */
  readonly publicLine: string;
  /** The unencrypted `openssh-key-v1` private key, PEM-armoured, newline-terminated. */
  readonly privateText: string;
}

/** A fresh ed25519 pair from the operating system's random source, in the formats ssh reads. */
export function generateOpenSshPair(): OpenSshPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = tail(publicKey.export({ type: 'spki', format: 'der' }), ED25519_PUBLIC_BYTES);
  const seed = tail(privateKey.export({ type: 'pkcs8', format: 'der' }), ED25519_SEED_BYTES);

  const blob = Buffer.concat([sshString(KEY_TYPE), sshString(pub)]);
  const check = randomBytes(4).readUInt32BE();
  let inner = Buffer.concat([
    uint32(check),
    uint32(check),
    sshString(KEY_TYPE),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(''),
  ]);
  const pad = (BLOCK - (inner.length % BLOCK)) % BLOCK;
  inner = Buffer.concat([inner, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);

  const body = Buffer.concat([
    Buffer.from(OPENSSH_MAGIC, 'latin1'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(blob),
    sshString(inner),
  ]);
  const wrapped = (body.toString('base64').match(/.{1,70}/g) ?? []).join('\n');
  return {
    publicLine: `${KEY_TYPE} ${blob.toString('base64')}`,
    privateText: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
}

type Handle = Awaited<ReturnType<typeof open>>;

export class FileSlotKeys implements SlotKeys {
  /** `dir` is a directory the controller owns, inside its state directory. */
  constructor(private readonly dir: string) {}

  private pathOf(slot: string, suffix: 'key' | 'pub'): string {
    if (!SLOT.test(slot)) throw new PermanentStepError('the slot is not a valid slot name');
    return join(this.dir, `${slot}.${suffix}`);
  }

  async ensure(slot: string): Promise<void> {
    const keyPath = this.pathOf(slot, 'key');
    const pubPath = this.pathOf(slot, 'pub');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if ((await this.exists(keyPath)) && (await this.exists(pubPath))) return;
    if ((await this.exists(keyPath)) !== (await this.exists(pubPath))) {
      // Half a pair means a crash after the private half; the pair was never sent to a host
      // (`key` runs after this step is recorded), so it is safe to refuse and leave to a person
      // rather than guess which half is right.
      throw new PermanentStepError(
        'the slot key directory holds half a key pair; nothing is replaced'
      );
    }
    const pair = generateOpenSshPair();
    // Public half first: a crash between the two leaves the half `ensure` refuses, never a
    // private key without its record.
    await this.writeNew(pubPath, `${pair.publicLine}\n`, 0o600);
    await this.writeNew(keyPath, pair.privateText, 0o600);
  }

  async publicKey(slot: string): Promise<string> {
    const text = await this.readExisting(this.pathOf(slot, 'pub'));
    const line = text.trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(line)) {
      throw new PermanentStepError('the slot public key file is not one ed25519 key');
    }
    return line;
  }

  async privateKeyPath(slot: string): Promise<string> {
    const path = this.pathOf(slot, 'key');
    await this.readExisting(path, false);
    return path;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      await file.close();
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return false;
      throw new PermanentStepError('a slot key file cannot be opened');
    }
  }

  private async writeNew(path: string, text: string, mode: number): Promise<void> {
    let file: Handle;
    try {
      file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode
      );
    } catch {
      throw new PermanentStepError('a slot key file could not be created');
    }
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  /** Opens a key file without following a link and refuses one others can reach; reads it when asked. */
  private async readExisting(path: string, read = true): Promise<string> {
    let file: Handle;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new PermanentStepError('the slot key pair has not been made');
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new PermanentStepError('a slot key file is not a regular file');
      if ((info.mode & 0o077) !== 0) {
        throw new PermanentStepError('a slot key file can be reached by other users');
      }
      return read ? await file.readFile('utf8') : '';
    } finally {
      await file.close();
    }
  }
}
