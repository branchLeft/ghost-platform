import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PermanentStepError } from './errors.js';
import { TrustedFileError } from './trustedFile.js';

/**
 * The hand-over between the step that makes a tenant's database and the step that delivers its
 * secrets. db-t1 prints the new account's password once and never again, and a second create is
 * refused (`exists`), so a crash between the two steps would lose the only copy. This port holds
 * that copy for exactly that window: written when `create-database` has the reply, read by
 * `render-host-secrets`, and discarded once the app host has the secrets file in place.
 *
 * The value is never in a log, an error, the state file or a run record. It lives in one private
 * file per slot, in a directory the deployment names (the controller's own state directory).
 */
export interface DatabaseHandOver {
  /** True when a copy is held for the slot. Throws when something is there that cannot be trusted. */
  has(slot: string): Promise<boolean>;
  /** Holds the password. Refuses (permanently) when a copy is already held: it is never replaced. */
  store(slot: string, password: string): Promise<void>;
  /** The held password, or undefined when none is held. */
  read(slot: string): Promise<string | undefined>;
  /** Removes the copy. Nothing held is not an error. */
  discard(slot: string): Promise<void>;
}

/** The shape db-t1's generated passwords have (`secrets.token_urlsafe`), with room either side. */
export const DB_PASSWORD_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

const SLOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A copy holds one short JSON object; anything larger is not one of ours. */
const MAX_COPY_BYTES = 4096;
/** The directory may not be written by group or other, nor reached by other. */
const DIRECTORY_FORBIDDEN = 0o027;
/** The file is private to its owner. */
const FILE_FORBIDDEN = 0o077;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code;

export class FileDatabaseHandOver implements DatabaseHandOver {
  /**
   * @param directory absolute path of the directory that holds the copies
   * @param owner the user id that must own the directory and every copy (the controller's own)
   */
  constructor(
    private readonly directory: string,
    private readonly owner: number | undefined = process.getuid?.()
  ) {}

  /** What is wrong with the directory, named; empty when it can be used. Never reads a copy. */
  async problems(): Promise<string[]> {
    try {
      await this.checkDirectory();
      return [];
    } catch (e) {
      if (e instanceof TrustedFileError) return [`the hand-over directory ${e.message}`];
      throw e;
    }
  }

  async has(slot: string): Promise<boolean> {
    return (await this.read(slot)) !== undefined;
  }

  async read(slot: string): Promise<string | undefined> {
    const path = this.pathFor(slot);
    await this.checkDirectory();
    let file: Awaited<ReturnType<typeof open>>;
    try {
      // O_NONBLOCK: a FIFO planted at the path must not hold this open for a writer.
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      const code = codeOf(e);
      if (code === 'ENOENT') return undefined;
      throw new TrustedFileError(
        path,
        code === 'ELOOP' ? 'it is a symbolic link' : 'it cannot be opened'
      );
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new TrustedFileError(path, 'it is not a regular file');
      if (this.owner !== undefined && info.uid !== this.owner) {
        throw new TrustedFileError(path, 'it belongs to another user');
      }
      if ((info.mode & FILE_FORBIDDEN) !== 0) {
        throw new TrustedFileError(path, 'its mode lets other users reach it');
      }
      if (info.nlink !== 1) throw new TrustedFileError(path, 'it has more than one link');
      if (info.size > MAX_COPY_BYTES) throw new TrustedFileError(path, 'it is too large');
      const text = await file.readFile('utf8');
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new TrustedFileError(path, 'it is not JSON');
      }
      const password = isRecord(doc) && Object.keys(doc).length === 1 ? doc['password'] : undefined;
      if (typeof password !== 'string' || !DB_PASSWORD_SHAPE.test(password)) {
        throw new TrustedFileError(path, 'it does not hold one database credential');
      }
      return password;
    } finally {
      await file.close();
    }
  }

  async store(slot: string, password: string): Promise<void> {
    const final = this.pathFor(slot);
    if (!DB_PASSWORD_SHAPE.test(password)) {
      throw new PermanentStepError('the database credential is not in a form the controller holds');
    }
    await this.checkDirectory();
    const temporary = join(this.directory, `.${slot}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await file.chmod(0o600);
        await file.writeFile(JSON.stringify({ password }));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        // A link, not a rename: it fails if a copy (or anything else) is already there.
        await link(temporary, final);
      } catch (e) {
        if (codeOf(e) === 'EEXIST') {
          throw new PermanentStepError(
            `a hand-over copy is already held for slot ${slot}; it is never replaced`
          );
        }
        throw e;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await this.syncDirectory();
  }

  async discard(slot: string): Promise<void> {
    const path = this.pathFor(slot);
    await this.checkDirectory();
    try {
      await unlink(path);
    } catch (e) {
      if (codeOf(e) === 'ENOENT') return;
      throw e;
    }
    await this.syncDirectory();
  }

  private pathFor(slot: string): string {
    if (typeof slot !== 'string' || !SLOT.test(slot)) {
      throw new PermanentStepError('the slot is not a valid slot name for a hand-over copy');
    }
    return join(this.directory, `db-handover-${slot}.json`);
  }

  private async checkDirectory(): Promise<void> {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(this.directory);
    } catch {
      throw new TrustedFileError(this.directory, 'it cannot be read');
    }
    if (info.isSymbolicLink()) throw new TrustedFileError(this.directory, 'it is a symbolic link');
    if (!info.isDirectory()) throw new TrustedFileError(this.directory, 'it is not a directory');
    if (this.owner !== undefined && info.uid !== this.owner) {
      throw new TrustedFileError(this.directory, 'it belongs to another user');
    }
    if ((info.mode & DIRECTORY_FORBIDDEN) !== 0) {
      throw new TrustedFileError(this.directory, 'its mode lets other users write or reach it');
    }
  }

  private async syncDirectory(): Promise<void> {
    const handle = await open(this.directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
