/**
 * The one place a slot's Ghost access key touches disk: one private folder
 * per slot (0700) holding one file (0600), written atomically, both owned
 * by the broker account. See keyStore.md#keystore.
 */
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
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
      let info;
      try {
        info = await lstat(path);
      } catch (err) {
        if ((err as { code?: unknown }).code === 'ENOENT') return null;
        throw err;
      }
      // A token anyone else could have read, written or swapped in is not
      // trusted: refuse it rather than use it.
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
      const raw = await readFile(path, 'utf8');
      const key = raw.trim();
      if (!isAdminApiKey(key)) {
        throw new Error(`the stored access key for slot "${slot}" is not a Ghost Admin API key`);
      }
      return key;
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
