import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { encryptToFile } from './ageEncryption.js';

export interface ArchiveFile {
  readonly name: string;
  readonly data: Buffer | string;
}

export class ArchiveEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveEntryError';
  }
}

const BLOCK = 512;
// ustar's size field is 11 octal digits.
const MAX_ENTRY_BYTES = 8 ** 11 - 1;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function writeOctal(header: Buffer, value: number, offset: number, width: number): void {
  header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
}

function ustarHeader(name: string, size: number, mtimeSeconds: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'ascii');
  writeOctal(header, 0o600, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, mtimeSeconds, 136, 12);
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

/**
 * A plain ustar archive, built in memory so that the only thing that ever
 * reaches disk is `age`'s ciphertext of it. Entry names are the fixed,
 * short names this package chooses, never a filename Ghost supplied, so no
 * long-name extension is needed.
 */
export function buildTar(files: readonly ArchiveFile[], mtimeSeconds: number): Buffer {
  const parts: Buffer[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!SAFE_NAME.test(file.name) || file.name === '.' || file.name === '..') {
      throw new ArchiveEntryError(`unsafe archive entry name: ${JSON.stringify(file.name)}`);
    }
    if (seen.has(file.name)) {
      throw new ArchiveEntryError(`duplicate archive entry name: ${file.name}`);
    }
    seen.add(file.name);
    const data = typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : file.data;
    if (data.length > MAX_ENTRY_BYTES) {
      throw new ArchiveEntryError(`archive entry ${file.name} exceeds the ustar size limit`);
    }
    parts.push(ustarHeader(file.name, data.length, mtimeSeconds), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `mode` applies only when mkdir creates the directory; an existing one
  // keeps whatever it had unless tightened here.
  await chmod(dir, 0o700);
}

/**
 * LLD-8 §08b's "one archive with a manifest", encrypted to the tenant's
 * own `age` recipient. The ciphertext is written 0600 inside a 0700
 * directory.
 */
export async function writeEncryptedArchive(
  destPath: string,
  files: readonly ArchiveFile[],
  mtimeSeconds: number,
  recipient: string,
  ageCommand?: string
): Promise<void> {
  await ensurePrivateDir(dirname(destPath));
  await encryptToFile(buildTar(files, mtimeSeconds), recipient, destPath, ageCommand);
}

/**
 * The manifest beside the archive, readable without the tenant's key: it
 * says what the archive holds and to whom it is encrypted, and carries no
 * tenant content.
 */
export async function writeManifestSidecar(destPath: string, manifestJson: string): Promise<void> {
  await ensurePrivateDir(dirname(destPath));
  await writeFile(destPath, manifestJson, { mode: 0o600, flag: 'wx' });
}
