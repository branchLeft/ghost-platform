import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RefusalLogEntry } from '../src/admit.js';
import type { CredentialRecord } from '../src/contracts.js';
import {
  DEFAULT_BODY_CEILING_MIB,
  SPOOL_THRESHOLD_BYTES,
  receiveBody,
  resolveBodyCeiling,
  sweepSpoolDir,
  type ReceiveBodyOptions,
  type ReceivedBody,
  type SpoolFile,
} from '../src/body.js';
import type { UpstreamTransport } from '../src/upstream.js';

const MIB = 1024 * 1024;
const LOG = { method: 'PUT' } as const;
const STALE = 'bl-spool-0f8fad5b-d9cb-469f-a165-70867728950e.part';

let spoolDir: string;

beforeEach(async () => {
  spoolDir = await mkdtemp(join(tmpdir(), 'body-stage-'));
});

afterEach(async () => {
  await rm(spoolDir, { recursive: true, force: true });
});

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const spoolFiles = (): Promise<string[]> => readdir(spoolDir);

function bytesOf(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

/** A source that yields the data in chunks of the given size, then ends. */
function sourceOf(data: Buffer, chunkSize = 1024): Readable {
  const chunks: Buffer[] = [];
  for (let at = 0; at < data.length; at += chunkSize)
    chunks.push(data.subarray(at, at + chunkSize));
  return Readable.from(chunks);
}

function options(extra: Partial<ReceiveBodyOptions> = {}): ReceiveBodyOptions {
  return { ceilingBytes: 1 * MIB, spoolDir, thresholdBytes: 64, log: LOG, ...extra };
}

async function drain(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

async function accepted(
  source: Readable,
  extra: Partial<ReceiveBodyOptions> = {}
): Promise<ReceivedBody> {
  const result = await receiveBody(source, options(extra));
  if (!result.ok) throw new Error(`expected the body to be accepted, got ${result.refusal.code}`);
  return result.body;
}

/** The sequence the HTTP adapter follows: the transport is reached only with an accepted body. */
async function receiveThenForward(
  source: Readable,
  transport: UpstreamTransport,
  extra: Partial<ReceiveBodyOptions> = {}
): Promise<string> {
  const result = await receiveBody(source, options(extra));
  if (!result.ok) return result.refusal.code;
  try {
    await transport({
      method: 'PUT',
      url: new URL('http://127.0.0.1:1/'),
      headers: {},
      body: result.body.open(),
      signal: new AbortController().signal,
    });
    return 'forwarded';
  } finally {
    await result.body.dispose();
  }
}

describe('resolveBodyCeiling', () => {
  const base: CredentialRecord = {
    folder: 'q7f3k2m9x1',
    bucket: 'media-shard-a',
    state: 'active',
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('gives 128 MiB when the credential names no ceiling', () => {
    expect(DEFAULT_BODY_CEILING_MIB).toBe(128);
    expect(resolveBodyCeiling(base)).toEqual({ ok: true, bytes: 128 * MIB });
  });

  it('honours the credential field', () => {
    expect(resolveBodyCeiling({ ...base, uploadCeilingMib: 5 })).toEqual({
      ok: true,
      bytes: 5 * MIB,
    });
  });

  it.each([0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 40])(
    'refuses %s as credential-invalid, never as "no cap"',
    (value) => {
      const result = resolveBodyCeiling({ ...base, uploadCeilingMib: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe('credential-invalid');
    }
  );
});

describe('receiveBody: small bodies stay in memory', () => {
  it('hashes, sizes and re-opens a body without touching the disk', async () => {
    const data = bytesOf(40);
    const body = await accepted(sourceOf(data, 7));
    expect(body.size).toBe(40);
    expect(body.sha256).toBe(sha(data));
    expect(await spoolFiles()).toEqual([]);
    expect(await drain(body.open())).toEqual(data);
    expect(await drain(body.open())).toEqual(data);
    await body.dispose();
  });

  it('accepts an empty body', async () => {
    const body = await accepted(Readable.from([]), { declaredLength: 0 });
    expect(body.size).toBe(0);
    expect(body.sha256).toBe(sha(''));
    expect(await drain(body.open())).toEqual(Buffer.alloc(0));
  });

  it('accepts string and Uint8Array chunks as bytes', async () => {
    const body = await accepted(Readable.from(['ab', new Uint8Array([99, 100])]));
    expect(await drain(body.open())).toEqual(Buffer.from('abcd'));
    expect(body.sha256).toBe(sha('abcd'));
  });

  it('keeps a body of exactly the threshold in memory and spools one byte more', async () => {
    const opened: string[] = [];
    const seam = async (path: string): Promise<SpoolFile> => {
      opened.push(path);
      const handle = await open(path, 'wx', 0o600);
      return {
        write: async (chunk) => void (await handle.write(chunk)),
        close: () => handle.close(),
      };
    };
    const atThreshold = await accepted(sourceOf(bytesOf(16), 4), {
      thresholdBytes: 16,
      openSpool: seam,
    });
    expect(opened).toEqual([]);
    await atThreshold.dispose();
    const over = await accepted(sourceOf(bytesOf(17), 4), { thresholdBytes: 16, openSpool: seam });
    expect(opened).toHaveLength(1);
    await over.dispose();
  });

  it('uses 4 MiB as its default threshold', () => {
    expect(SPOOL_THRESHOLD_BYTES).toBe(4 * MIB);
  });
});

describe('receiveBody: spooled bodies', () => {
  it('spools a body past the threshold to an owner-only file and reads it back twice', async () => {
    const data = bytesOf(5000);
    const body = await accepted(sourceOf(data, 300));
    const files = await spoolFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^bl-spool-[0-9a-f-]{36}\.part$/);
    expect((await stat(join(spoolDir, files[0] ?? ''))).mode & 0o777).toBe(0o600);
    expect(body.size).toBe(5000);
    expect(body.sha256).toBe(sha(data));
    expect(await drain(body.open())).toEqual(data);
    expect(await drain(body.open())).toEqual(data);
    await body.dispose();
    expect(await spoolFiles()).toEqual([]);
  });

  it('dispose is idempotent, survives a file already gone, and stops open()', async () => {
    const body = await accepted(sourceOf(bytesOf(500), 100));
    const [name] = await spoolFiles();
    await unlink(join(spoolDir, name ?? ''));
    await body.dispose();
    await body.dispose();
    expect(() => body.open()).toThrow('disposed');
  });

  it('fails dispose on an error other than a missing file, and keeps the body open', async () => {
    const body = await accepted(sourceOf(bytesOf(500), 100));
    const [name] = await spoolFiles();
    const path = join(spoolDir, name ?? '');
    await unlink(path);
    await mkdir(path);
    await expect(body.dispose()).rejects.toThrow();
    await rm(path, { recursive: true });
  });

  it('streams 128 MiB in 64 KiB chunks with memory held near the threshold', async () => {
    const total = 128 * MIB;
    const chunkSize = 64 * 1024;
    const hash = createHash('sha256');
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    let sent = 0;
    async function* generate(): AsyncGenerator<Buffer> {
      for (let n = 0; sent < total; n += 1) {
        const chunk = Buffer.alloc(chunkSize, n & 0xff);
        hash.update(chunk);
        sent += chunk.length;
        if (n % 64 === 0) peak = Math.max(peak, process.memoryUsage().rss);
        yield chunk;
      }
    }
    const body = await accepted(Readable.from(generate()), {
      ceilingBytes: total,
      thresholdBytes: SPOOL_THRESHOLD_BYTES,
    });
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(body.size).toBe(total);
    expect(body.sha256).toBe(hash.digest('hex'));
    expect(peak - baseline).toBeLessThan(64 * MIB);

    const again = createHash('sha256');
    let seen = 0;
    for await (const part of body.open()) {
      again.update(part as Buffer);
      seen += (part as Buffer).length;
    }
    expect(seen).toBe(total);
    expect(again.digest('hex')).toBe(body.sha256);
    const [name] = await spoolFiles();
    expect((await stat(join(spoolDir, name ?? ''))).size).toBe(total);
    await body.dispose();
    expect(await spoolFiles()).toEqual([]);
  }, 120_000);
});

describe('receiveBody: the cap', () => {
  it('accepts a body of exactly the ceiling', async () => {
    const body = await accepted(sourceOf(bytesOf(1000), 100), { ceilingBytes: 1000 });
    expect(body.size).toBe(1000);
    await body.dispose();
  });

  it('refuses a body one byte over, leaves the spool empty and reaches no upstream', async () => {
    let calls = 0;
    const transport: UpstreamTransport = async () => {
      calls += 1;
      throw new Error('must not be reached');
    };
    const code = await receiveThenForward(sourceOf(bytesOf(1001), 100), transport, {
      ceilingBytes: 1000,
    });
    expect(code).toBe('body-too-large');
    expect(calls).toBe(0);
    expect(await spoolFiles()).toEqual([]);
  });

  it('refuses one byte over when the crossing chunk is the first and only one', async () => {
    const result = await receiveBody(sourceOf(bytesOf(11), 11), options({ ceilingBytes: 10 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('body-too-large');
      expect(result.refusal.status).toBe(413);
    }
  });

  it('refuses a declared length over the ceiling without reading a byte', async () => {
    let reads = 0;
    const source = new Readable({
      read() {
        reads += 1;
        this.push(Buffer.alloc(10));
      },
    });
    const result = await receiveBody(source, options({ ceilingBytes: 1000, declaredLength: 1001 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('body-too-large');
    expect(reads).toBe(0);
    expect(source.destroyed).toBe(true);
    expect(await spoolFiles()).toEqual([]);
  });

  it('stops reading the source once the cap is passed', async () => {
    let produced = 0;
    async function* endless(): AsyncGenerator<Buffer> {
      for (;;) {
        produced += 100;
        yield Buffer.alloc(100);
      }
    }
    const result = await receiveBody(Readable.from(endless()), options({ ceilingBytes: 1000 }));
    expect(result.ok).toBe(false);
    expect(produced).toBeLessThan(1000 + 100 * 20);
    expect(await spoolFiles()).toEqual([]);
  });
});

describe('receiveBody: incomplete bodies', () => {
  it('refuses a body shorter than its declared length', async () => {
    const result = await receiveBody(sourceOf(bytesOf(50), 10), options({ declaredLength: 60 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('body-incomplete');
      expect(result.refusal.status).toBe(400);
    }
    expect(await spoolFiles()).toEqual([]);
  });

  it('refuses a body longer than its declared length, spooled or not', async () => {
    for (const thresholdBytes of [64, 4]) {
      const result = await receiveBody(
        sourceOf(bytesOf(50), 10),
        options({ declaredLength: 40, thresholdBytes })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe('body-incomplete');
      expect(await spoolFiles()).toEqual([]);
    }
  });

  it('accepts a body that matches its declared length', async () => {
    const body = await accepted(sourceOf(bytesOf(50), 10), { declaredLength: 50 });
    expect(body.size).toBe(50);
  });

  it.each([Number.NaN, -1, 1.5])('refuses a declared length of %s', async (declaredLength) => {
    const result = await receiveBody(sourceOf(bytesOf(5)), options({ declaredLength }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('body-incomplete');
  });

  async function cutOff(how: 'error' | 'close'): Promise<void> {
    const source = new PassThrough();
    const pending = receiveBody(source, options({ thresholdBytes: 8 }));
    source.write(bytesOf(100));
    await new Promise((resolve) => setImmediate(resolve));
    if (how === 'error') source.destroy(new Error('socket hang up'));
    else source.destroy();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('body-incomplete');
    expect(await spoolFiles()).toEqual([]);
  }

  it('refuses a source that errors mid-stream and removes the spool file', () => cutOff('error'));
  it('refuses a source destroyed mid-stream (the killed request) and removes the file', () =>
    cutOff('close'));

  it('refuses a request aborted mid-stream and removes the spool file', async () => {
    const source = new PassThrough();
    const controller = new AbortController();
    const pending = receiveBody(source, options({ thresholdBytes: 8, signal: controller.signal }));
    source.write(bytesOf(100));
    await new Promise((resolve) => setImmediate(resolve));
    expect((await spoolFiles()).length).toBe(1);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('body-incomplete');
    expect(await spoolFiles()).toEqual([]);
  });

  it('refuses a request already aborted before the read', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = sourceOf(bytesOf(10));
    const result = await receiveBody(source, options({ signal: controller.signal }));
    expect(result.ok).toBe(false);
    expect(source.destroyed).toBe(true);
  });
});

describe('receiveBody: spool failures fail closed', () => {
  async function failingSeam(path: string, failOnWrite: number): Promise<SpoolFile> {
    const handle = await open(path, 'wx', 0o600);
    let writes = 0;
    return {
      async write(chunk) {
        writes += 1;
        if (writes >= failOnWrite) {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        await handle.write(chunk);
      },
      close: () => handle.close(),
    };
  }

  it('answers internal-error and unlinks the file when a write fails (ENOSPC)', async () => {
    const result = await receiveBody(
      sourceOf(bytesOf(2000), 100),
      options({ openSpool: (path) => failingSeam(path, 3) })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('internal-error');
      expect(result.refusal.status).toBe(503);
    }
    expect(await spoolFiles()).toEqual([]);
  });

  it('answers internal-error when the spool cannot be opened', async () => {
    const result = await receiveBody(
      sourceOf(bytesOf(2000), 100),
      options({
        openSpool: async () => {
          throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
        },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('internal-error');
    expect(await spoolFiles()).toEqual([]);
  });

  it('answers internal-error and unlinks the file when the final flush fails', async () => {
    const result = await receiveBody(
      sourceOf(bytesOf(2000), 100),
      options({
        openSpool: async (path) => {
          const handle = await open(path, 'wx', 0o600);
          return {
            write: async (chunk) => void (await handle.write(chunk)),
            close: async () => {
              await handle.close();
              throw new Error('EIO');
            },
          };
        },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('internal-error');
    expect(await spoolFiles()).toEqual([]);
  });

  it('answers internal-error when the spool directory does not exist', async () => {
    const result = await receiveBody(
      sourceOf(bytesOf(2000), 100),
      options({ spoolDir: join(spoolDir, 'missing') })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('internal-error');
  });
});

describe('receiveBody: logging', () => {
  it('logs a refusal with the tenant context and nothing else', async () => {
    const entries: RefusalLogEntry[] = [];
    await receiveBody(
      sourceOf(bytesOf(2000), 100),
      options({
        ceilingBytes: 1000,
        logger: { refusal: (entry) => entries.push(entry) },
        log: { method: 'PUT', keyId: 'KEY1', folder: 'q7f3k2m9x1', operation: 'PutObject' },
      })
    );
    expect(entries).toEqual([
      {
        event: 'request-refused',
        code: 'body-too-large',
        status: 413,
        method: 'PUT',
        keyId: 'KEY1',
        folder: 'q7f3k2m9x1',
        operation: 'PutObject',
      },
    ]);
  });

  it('logs only the method when nothing else is known', async () => {
    const entries: RefusalLogEntry[] = [];
    await receiveBody(
      sourceOf(bytesOf(20)),
      options({ ceilingBytes: 10, logger: { refusal: (entry) => entries.push(entry) } })
    );
    expect(entries).toEqual([
      { event: 'request-refused', code: 'body-too-large', status: 413, method: 'PUT' },
    ]);
  });

  it('still refuses when the logger throws', async () => {
    const result = await receiveBody(
      sourceOf(bytesOf(20)),
      options({
        ceilingBytes: 10,
        logger: {
          refusal: () => {
            throw new Error('log sink down');
          },
        },
      })
    );
    expect(result.ok).toBe(false);
  });
});

describe('sweepSpoolDir', () => {
  it('removes stale spool files and leaves everything else', async () => {
    await writeFile(join(spoolDir, STALE), 'x');
    await writeFile(join(spoolDir, 'bl-spool-11111111-2222-3333-4444-555555555555.part'), 'y');
    await writeFile(join(spoolDir, 'notes.txt'), 'keep');
    await writeFile(join(spoolDir, 'bl-spool-not-ours.part'), 'keep');
    await mkdir(join(spoolDir, 'nested'));
    await writeFile(join(spoolDir, 'nested', STALE), 'keep');
    const outside = join(spoolDir, 'nested', 'target.txt');
    await writeFile(outside, 'keep');
    await symlink(outside, join(spoolDir, 'bl-spool-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.part'));

    expect(await sweepSpoolDir(spoolDir)).toBe(2);
    expect((await spoolFiles()).sort()).toEqual([
      'bl-spool-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.part',
      'bl-spool-not-ours.part',
      'nested',
      'notes.txt',
    ]);
    expect((await stat(outside)).size).toBe(4);
    expect(await readdir(join(spoolDir, 'nested'))).toContain(STALE);
  });

  it('creates a missing directory owner-only and removes nothing', async () => {
    const fresh = join(spoolDir, 'made', 'spool');
    expect(await sweepSpoolDir(fresh)).toBe(0);
    expect((await stat(fresh)).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlinked spool directory', async () => {
    const real = join(spoolDir, 'real');
    await mkdir(real);
    await writeFile(join(real, STALE), 'x');
    const link = join(spoolDir, 'link');
    await symlink(real, link);
    await expect(sweepSpoolDir(link)).rejects.toThrow();
    expect(await readdir(real)).toEqual([STALE]);
  });

  it('refuses a path that is a file', async () => {
    const file = join(spoolDir, 'plain');
    await writeFile(file, 'x');
    await expect(sweepSpoolDir(file)).rejects.toThrow();
  });
});
