import { constants, type Stats } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StateCorruptError, StateFileUnsafeError } from './errors.js';
import { RUN_EVENTS, STEP_EVENTS, type StateRecord, type StateStore } from './executePorts.js';

const NEWLINE = 0x0a;
const OTHERS = 0o077;
/**
 * Never follow a link at the final path component, and never wait for a peer:
 * a named pipe opened for reading blocks until a writer appears, before the
 * type check could refuse it. O_NONBLOCK changes nothing for a regular file.
 */
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const APPEND_FLAGS =
  constants.O_RDWR |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

type Handle = Awaited<ReturnType<typeof open>>;

/** What makes an opened file unfit to hold the run's history, or undefined when it is fit. */
function unsafeBecause(info: Stats): string | undefined {
  if (!info.isFile()) return 'it is not a regular file';
  if ((info.mode & OTHERS) !== 0) return 'its permissions let other users reach it';
  return undefined;
}

const EVENTS: readonly string[] = [...STEP_EVENTS, ...RUN_EVENTS];

const isString = (v: unknown): v is string => typeof v === 'string';

/** Returns the record, or the reason the line cannot be one. */
function parseRecord(line: string): StateRecord | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return 'not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
  const r = value as Record<string, unknown>;
  if (!isString(r['at']) || !isString(r['approvalId']) || !isString(r['event'])) {
    return 'missing at, approvalId or event';
  }
  if (!EVENTS.includes(r['event'])) return 'unknown event';
  for (const field of ['key', 'inputDigest', 'reason']) {
    if (r[field] !== undefined && !isString(r[field])) return `${field} is not text`;
  }
  if (r['attempt'] !== undefined && !Number.isInteger(r['attempt']))
    return 'attempt is not a count';
  if ((STEP_EVENTS as readonly string[]).includes(r['event'])) {
    if (!isString(r['key']) || !isString(r['inputDigest']))
      return 'step event without key or digest';
  }
  return r as unknown as StateRecord;
}

/**
 * The durable state store: one JSON record per line, appended and fsynced
 * before `append` resolves. A final line with no terminating newline is a
 * write that never finished, so it was never acknowledged: it is ignored on
 * read and cut off before the next append. Any other unusable line makes the
 * whole file unreadable. A missing file reads as an empty history.
 */
export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  async readAll(): Promise<readonly StateRecord[]> {
    let file: Handle;
    try {
      file = await this.openChecked(READ_FLAGS);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return [];
      throw e;
    }
    let text: string;
    try {
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
    const lines = text.split('\n');
    lines.pop();
    return lines.map((line, i) => {
      const parsed = parseRecord(line);
      if (typeof parsed === 'string') throw new StateCorruptError(i + 1, parsed);
      return parsed;
    });
  }

  async append(record: StateRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const file = await this.openChecked(APPEND_FLAGS, 0o600);
    try {
      const { size } = await file.stat();
      if (size > 0) await this.cutTornTail(file, size);
      await file.write(`${JSON.stringify(record)}\n`);
      await file.sync();
      if (size === 0) await this.syncDirectory();
    } finally {
      await file.close();
    }
  }

  /**
   * Opens the file and judges the open handle, not the path, so nothing can be
   * swapped in between the check and the use. A file the store created is
   * private; one that already exists is refused when others can reach it,
   * never quietly changed.
   */
  private async openChecked(flags: number, mode?: number): Promise<Handle> {
    let file: Handle;
    try {
      file = await open(this.path, flags, mode);
    } catch (e) {
      if ((e as { code?: string }).code === 'ELOOP') {
        throw new StateFileUnsafeError('it is a symbolic link');
      }
      throw e;
    }
    try {
      const problem = unsafeBecause(await file.stat());
      if (problem !== undefined) throw new StateFileUnsafeError(problem);
    } catch (e) {
      await file.close();
      throw e;
    }
    return file;
  }

  private async cutTornTail(file: Handle, size: number): Promise<void> {
    const last = Buffer.alloc(1);
    await file.read(last, 0, 1, size - 1);
    if (last[0] === NEWLINE) return;
    const whole = await file.readFile();
    await file.truncate(whole.lastIndexOf(NEWLINE) + 1);
  }

  private async syncDirectory(): Promise<void> {
    const dir = await open(dirname(this.path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
