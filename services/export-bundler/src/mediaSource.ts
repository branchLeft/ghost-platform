import { spawn } from 'node:child_process';
import { dockerRemoveUntilGoneSync, processCleanup, type CleanupRegistry } from './cleanup.js';
import { GHOST_CONTENT_DIR, NO_CONTAINER_LOGS } from './containerRunner.js';
import { MediaTreeRefusedError, MediaTreeTooLargeError } from './mediaTree.js';

/**
 * Where a demo slot's served media tree is read from: a throwaway container
 * of the tenant's own image that mounts the content volume read-only, as an
 * unprivileged user, with no network. The tree is the demo's own and the live
 * demo's Ghost keeps writing to it, so nothing on the host ever opens a path
 * inside it: a link a tenant plants resolves inside that container's own
 * namespace, where there is nothing of the host's, and the script below does
 * not resolve a path twice either.
 */

/** One regular file of the served tree, as read. */
export interface TreeEntry {
  /** Below the content directory: `images/2026/a.png`. */
  readonly rel: string;
  readonly size: number;
  /** Null for a file over the upload ceiling, which is hashed and not carried. */
  readonly data: Buffer | null;
  /** Set only when `data` is null. */
  readonly sha256: string | null;
}

export interface MediaReadLimits {
  /** A file above this is hashed, not sent. */
  readonly uploadCeilingBytes: number;
  /** The bytes of carried files the host will hold; more refuses the export. */
  readonly maxCarriedBytes: number;
}

export interface MediaTreeSource {
  read(limits: MediaReadLimits): Promise<readonly TreeEntry[]>;
}

/**
 * Runs inside the container, on Linux. `argv`: the content directory, the
 * upload ceiling. It writes frames to stdout: a JSON line per file (`file`,
 * with `n` raw bytes after it, or `big`, with the size and sha256 and no
 * bytes), then `done`; or one `refused` frame and exit 3.
 *
 * Every directory is reached through the descriptor of its parent
 * (`/proc/self/fd/<n>/<name>`, last component opened with O_NOFOLLOW) and
 * checked against the lstat that found it, and a directory is listed through
 * its own descriptor, so no path is ever resolved a second time: a directory
 * swapped for a link after it was listed cannot lead the read anywhere else.
 * Anything that is not a regular file, or that changed between the lstat and
 * the open, refuses the whole read by name.
 */
export const MEDIA_READ_SCRIPT = [
  "'use strict';",
  "const fs = require('fs');",
  "const crypto = require('crypto');",
  'const C = fs.constants;',
  'const DIR = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;',
  'const FILE = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK;',
  'const [contentDir, ceilingText] = process.argv.slice(1);',
  'const ceiling = Number(ceilingText);',
  "const via = (fd) => '/proc/self/fd/' + fd;",
  'function put(buffer, from, to) {',
  '  let off = from;',
  '  while (off < to) {',
  '    try { off += fs.writeSync(1, buffer, off, to - off); }',
  "    catch (e) { if (e.code !== 'EAGAIN') throw e; }",
  '  }',
  '}',
  "function frame(o) { const b = Buffer.from(JSON.stringify(o) + '\\n'); put(b, 0, b.length); }",
  'class Refused extends Error { constructor(path, why) { super(why); this.path = path; } }',
  'function kind(st) {',
  "  if (st.isSymbolicLink()) return 'a symbolic link';",
  "  if (st.isDirectory()) return 'a directory';",
  "  if (st.isFile()) return 'a regular file';",
  "  if (st.isBlockDevice() || st.isCharacterDevice()) return 'a device';",
  "  if (st.isFIFO()) return 'a named pipe';",
  "  if (st.isSocket()) return 'a socket';",
  "  return 'not a regular file';",
  '}',
  'const same = (a, b) => a.dev === b.dev && a.ino === b.ino;',
  "const changed = (rel) => new Refused(rel, 'changed during the read');",
  'function openDir(parent, name, rel) {',
  "  const at = via(parent) + '/' + name;",
  '  const before = fs.lstatSync(at);',
  '  if (!before.isDirectory()) throw new Refused(rel, kind(before));',
  '  let fd;',
  '  try { fd = fs.openSync(at, DIR); }',
  "  catch (e) { if (e.code === 'ELOOP' || e.code === 'ENOTDIR') throw changed(rel); throw e; }",
  '  if (!same(fs.fstatSync(fd), before)) { fs.closeSync(fd); throw changed(rel); }',
  '  return fd;',
  '}',
  'function sendFile(parent, name, rel) {',
  "  const at = via(parent) + '/' + name;",
  '  let fd;',
  '  try { fd = fs.openSync(at, FILE); }',
  '  catch (e) {',
  "    if (e.code === 'ELOOP') throw new Refused(rel, 'a symbolic link');",
  "    if (e.code === 'ENOENT') return;",
  '    throw e;',
  '  }',
  '  try {',
  '    const st = fs.fstatSync(fd);',
  '    if (!st.isFile()) throw new Refused(rel, kind(st));',
  '    const chunk = Buffer.alloc(65536);',
  '    if (st.size > ceiling) {',
  "      const hash = crypto.createHash('sha256');",
  '      let total = 0;',
  '      for (;;) {',
  '        const got = fs.readSync(fd, chunk, 0, chunk.length, null);',
  '        if (got === 0) break;',
  '        hash.update(chunk.subarray(0, got));',
  '        total += got;',
  '      }',
  "      frame({ t: 'big', p: rel, n: total, sha256: hash.digest('hex') });",
  '      return;',
  '    }',
  "    frame({ t: 'file', p: rel, n: st.size });",
  '    let sent = 0;',
  '    while (sent < st.size) {',
  '      const got = fs.readSync(fd, chunk, 0, Math.min(chunk.length, st.size - sent), null);',
  "      if (got === 0) throw new Error('a file ended early');",
  '      put(chunk, 0, got);',
  '      sent += got;',
  '    }',
  '  } finally { fs.closeSync(fd); }',
  '}',
  'function walk(dir, rel) {',
  '  for (const name of fs.readdirSync(via(dir)).sort()) {',
  "    const relPath = rel + '/' + name;",
  "    if (relPath === 'images/size') continue;",
  '    let st;',
  "    try { st = fs.lstatSync(via(dir) + '/' + name); }",
  "    catch (e) { if (e.code === 'ENOENT') continue; throw e; }",
  '    if (st.isDirectory()) {',
  '      const fd = openDir(dir, name, relPath);',
  '      try { walk(fd, relPath); } finally { fs.closeSync(fd); }',
  '    } else if (st.isFile()) sendFile(dir, name, relPath);',
  '    else throw new Refused(relPath, kind(st));',
  '  }',
  '}',
  'try {',
  '  const base = fs.openSync(contentDir, DIR);',
  "  for (const root of ['images', 'media', 'files']) {",
  '    let fd;',
  '    try { fd = openDir(base, root, root); }',
  "    catch (e) { if (e.code === 'ENOENT') continue; throw e; }",
  '    try { walk(fd, root); } finally { fs.closeSync(fd); }',
  '  }',
  "  frame({ t: 'done' });",
  '} catch (e) {',
  "  if (e instanceof Refused) { frame({ t: 'refused', p: e.path, why: e.message }); process.exitCode = 3; }",
  "  else { process.stderr.write(String(e && e.message) + '\\n'); process.exitCode = 1; }",
  '}',
].join('\n');

export class MediaReadError extends Error {
  constructor(readonly detail: string) {
    super(`the media files of the slot could not be read (${detail})`);
    this.name = 'MediaReadError';
  }
}

const MAX_HEADER_BYTES = 8192;
const SHA256 = /^[0-9a-f]{64}$/;

interface Pending {
  readonly rel: string;
  readonly size: number;
  readonly parts: Buffer[];
  have: number;
}

/** Reads the frames the script writes, strictly: anything it does not recognise is an error. */
export class MediaFrameParser {
  readonly entries: TreeEntry[] = [];
  refused: { path: string; reason: string } | null = null;
  done = false;
  #buffer: Buffer = Buffer.alloc(0);
  #pending: Pending | null = null;
  #carried = 0;

  constructor(private readonly limits: MediaReadLimits) {}

  push(chunk: Buffer): void {
    if (this.done || this.refused !== null) {
      throw new MediaReadError('data after the last frame');
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#pending !== null) {
        const pending = this.#pending;
        const take = Math.min(pending.size - pending.have, this.#buffer.length);
        if (take > 0) {
          pending.parts.push(this.#buffer.subarray(0, take));
          pending.have += take;
          this.#buffer = this.#buffer.subarray(take);
        }
        if (pending.have < pending.size) return;
        this.entries.push({
          rel: pending.rel,
          size: pending.size,
          data: Buffer.concat(pending.parts),
          sha256: null,
        });
        this.#pending = null;
      }
      const eol = this.#buffer.indexOf(0x0a);
      if (eol === -1) {
        if (this.#buffer.length > MAX_HEADER_BYTES)
          throw new MediaReadError('a frame header is too long');
        return;
      }
      const line = this.#buffer.subarray(0, eol).toString('utf8');
      this.#buffer = this.#buffer.subarray(eol + 1);
      this.#header(line);
      if (this.done || this.refused !== null) {
        if (this.#buffer.length > 0) throw new MediaReadError('data after the last frame');
        return;
      }
    }
  }

  #header(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new MediaReadError('a frame header is not JSON');
    }
    const { t, p, n, sha256, why } = frame;
    const size = typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : -1;
    if (t === 'done') {
      this.done = true;
    } else if (t === 'refused' && typeof p === 'string' && typeof why === 'string') {
      this.refused = { path: p.slice(0, 1024), reason: why.slice(0, 100) };
    } else if (t === 'file' && typeof p === 'string' && size >= 0) {
      if (size > this.limits.uploadCeilingBytes) {
        throw new MediaReadError('a file frame is over the upload ceiling');
      }
      this.#carried += size;
      if (this.#carried > this.limits.maxCarriedBytes) {
        throw new MediaTreeTooLargeError(this.#carried, this.limits.maxCarriedBytes);
      }
      this.#pending = { rel: p, size, parts: [], have: 0 };
      if (size === 0) {
        this.entries.push({ rel: p, size, data: Buffer.alloc(0), sha256: null });
        this.#pending = null;
      }
    } else if (t === 'big' && typeof p === 'string' && size >= 0 && typeof sha256 === 'string') {
      if (!SHA256.test(sha256)) throw new MediaReadError('a checksum is not a sha256');
      this.entries.push({ rel: p, size, data: null, sha256 });
    } else {
      throw new MediaReadError('a frame is not one this reader knows');
    }
  }

  /** The entries, once the script said it was done; a refusal or a cut stream throws. */
  finish(): readonly TreeEntry[] {
    if (this.refused !== null) {
      throw new MediaTreeRefusedError(`content/${this.refused.path}`, this.refused.reason);
    }
    if (!this.done || this.#pending !== null) throw new MediaReadError('the stream ended early');
    return this.entries;
  }
}

/**
 * Runs `command args` and reads the frames from its stdout. A refusal frame
 * wins over the exit code; a stream that does not end in `done` is an error.
 */
export function readFrames(
  command: string,
  args: readonly string[],
  limits: MediaReadLimits,
  registry: CleanupRegistry = processCleanup
): Promise<readonly TreeEntry[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const untrack = registry.trackChild(child);
    const parser = new MediaFrameParser(limits);
    let failure: unknown;
    let stderr = '';
    const fail = (err: unknown): void => {
      failure ??= err;
      child.kill('SIGKILL');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure !== undefined) return;
      try {
        parser.push(chunk);
      } catch (err) {
        fail(err);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      untrack();
      reject(err);
    });
    child.on('close', (code) => {
      untrack();
      if (failure !== undefined) {
        reject(failure instanceof Error ? failure : new MediaReadError('read failed'));
        return;
      }
      try {
        const entries = parser.finish();
        if (code !== 0) throw new MediaReadError(`exit ${String(code)}`);
        resolve(entries);
      } catch (err) {
        // The script's own message is about the volume, never about tenant data.
        reject(
          err instanceof MediaReadError && stderr !== ''
            ? new MediaReadError(`${err.detail}; ${stderr.trim()}`)
            : err
        );
      }
    });
  });
}

export interface MediaContainerSpec {
  /** The run's id; the container is named from it so a signal can remove it. */
  readonly runId: string;
  /** The tenant's own image: Ghost's, which has node. */
  readonly image: string;
  /** The tenant's `uid:gid`; the volume is private to it. */
  readonly user: string | null;
  /** The content volume, mounted read-only. */
  readonly volume: string;
}

export function mediaReadName(runId: string): string {
  return `${runId}-media`;
}

/**
 * The throwaway reader: the content volume read-only, an unprivileged user,
 * no network, no capability, a read-only root, no log. Nothing else of the
 * host or of any tenant is mounted.
 */
export function buildMediaReadArgs(
  spec: MediaContainerSpec,
  limits: MediaReadLimits
): readonly string[] {
  return [
    'run',
    '--rm',
    '--name',
    mediaReadName(spec.runId),
    '--network',
    'none',
    ...NO_CONTAINER_LOGS,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '256m',
    '--user',
    spec.user ?? 'node',
    '--entrypoint',
    'node',
    '--mount',
    `type=volume,src=${spec.volume},dst=${GHOST_CONTENT_DIR},readonly`,
    spec.image,
    '-e',
    MEDIA_READ_SCRIPT,
    GHOST_CONTENT_DIR,
    String(limits.uploadCeilingBytes),
  ];
}

export function createContainerMediaSource(
  spec: MediaContainerSpec,
  options: { readonly dockerCommand?: string; readonly registry?: CleanupRegistry } = {}
): MediaTreeSource {
  const docker = options.dockerCommand ?? 'docker';
  const registry = options.registry ?? processCleanup;
  return {
    async read(limits) {
      const name = mediaReadName(spec.runId);
      const unregister = registry.register(`media reader ${name}`, () => {
        dockerRemoveUntilGoneSync(name, docker, registry);
      });
      try {
        return await readFrames(docker, buildMediaReadArgs(spec, limits), limits, registry);
      } finally {
        dockerRemoveUntilGoneSync(name, docker, registry);
        unregister();
      }
    },
  };
}
