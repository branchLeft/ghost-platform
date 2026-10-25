/**
 * The one place a slot's Ghost access key touches disk: one private folder
 * per slot (0700) holding one file (0600), written atomically, both owned
 * by the broker account. See keyStore.md#keystore.
 */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { removeFileIfPresent, writeFileAtomic } from '../atomicFile.js';

const KEY_FILE = 'ghost-admin-key';
const SLOT_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
// Ghost's Admin API key: a 24-hex-digit id, a colon, a 64-hex-digit secret.
const KEY_PATTERN = /^[0-9a-f]{24}:[0-9a-f]{64}$/;

export interface AdminKeyStore {
  read(slot: string): Promise<string | null>;
  write(slot: string, key: string): Promise<void>;
  remove(slot: string): Promise<void>;
}

export function isAdminApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

function slotDir(baseDir: string, slot: string): string {
  if (!SLOT_PATTERN.test(slot)) {
    throw new Error(`refusing a key path for slot "${slot}": not a plain slot name`);
  }
  return join(baseDir, slot);
}

async function assertPlainDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`refusing "${path}": not a plain directory`);
  }
}

export function createAdminKeyStore(
  baseDir: string,
  ownUid: () => number = () => process.getuid?.() ?? -1
): AdminKeyStore {
  return {
    async read(slot) {
      const path = join(slotDir(baseDir, slot), KEY_FILE);
      // Opened once, never following a symlink and never blocking on a named
      // pipe. Every check and the read use this handle, so the file checked
      // is the file read.
      let fh: FileHandle;
      try {
        fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code === 'ENOENT') return null;
        if (code === 'ELOOP') {
          throw new Error(`refusing the stored access key for slot "${slot}": not a plain file`);
        }
        throw err;
      }
      try {
        // A token anyone else could have read, written or swapped in is not
        // trusted: refuse it rather than use it.
        const info = await fh.stat();
        if (!info.isFile()) {
          throw new Error(`refusing the stored access key for slot "${slot}": not a plain file`);
        }
        if ((info.mode & 0o777) !== 0o600) {
          throw new Error(
            `refusing the stored access key for slot "${slot}": mode ${(info.mode & 0o777).toString(8)}, not 600`
          );
        }
        if (info.uid !== ownUid()) {
          throw new Error(
            `refusing the stored access key for slot "${slot}": owned by uid ${info.uid}, not this service`
          );
        }
        const raw = await fh.readFile('utf8');
        const key = raw.trim();
        if (!isAdminApiKey(key)) {
          throw new Error(`the stored access key for slot "${slot}" is not a Ghost Admin API key`);
        }
        return key;
      } finally {
        await fh.close();
      }
    },

    async write(slot, key) {
      if (!isAdminApiKey(key)) {
        throw new Error('refusing to store a value that is not a Ghost Admin API key');
      }
      const dir = slotDir(baseDir, slot);
      await mkdir(baseDir, { recursive: true, mode: 0o700 });
      await assertPlainDirectory(baseDir);
      await chmod(baseDir, 0o700);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await assertPlainDirectory(dir);
      await chmod(dir, 0o700);
      await writeFileAtomic(join(dir, KEY_FILE), `${key}\n`, 0o600);
    },

    async remove(slot) {
      const dir = slotDir(baseDir, slot);
      try {
        await assertPlainDirectory(dir);
      } catch (err) {
        if ((err as { code?: unknown }).code === 'ENOENT') return;
        throw err;
      }
      await removeFileIfPresent(join(dir, KEY_FILE));
    },
  };
}
