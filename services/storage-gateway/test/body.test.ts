import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BODY_CAP_BYTES,
  SPOOL_SUFFIX,
  clearSpoolDir,
  createBodyCapPolicy,
  readBody,
  withBody,
  type ReceivedBody,
} from '../src/body.js';

const MIB = 1024 * 1024;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gateway-spool-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const spooled = async (): Promise<string[]> => (await readdir(dir)).sort();

/** Chunks of a deterministic pattern, reusing one buffer the way a socket may. */
async function* pattern(total: number, chunkSize: number, onChunk?: () => void) {
  const buf = Buffer.alloc(chunkSize);
  for (let sent = 0; sent < total; sent += chunkSize) {
    const n = Math.min(chunkSize, total - sent);
    for (let i = 0; i < n; i += 1) buf[i] = (sent + i) % 251;
    onChunk?.();
    yield new Uint8Array(buf.buffer, buf.byteOffset, n);
  }
}

function expectedPattern(total: number): Buffer {
  const out = Buffer.alloc(total);
  for (let i = 0; i < total; i += 1) out[i] = i % 251;
  return out;
}

async function readAll(body: ReceivedBody): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body.open()) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe('createBodyCapPolicy', () => {
  it('gives every tenant 128 MiB unless raised for one', () => {
    const policy = createBodyCapPolicy({ overrides: { 'raised-key': 512 * MIB } });
    expect(DEFAULT_BODY_CAP_BYTES).toBe(128 * MIB);
    expect(policy.capFor('any-key')).toBe(128 * MIB);
    expect(policy.capFor('raised-key')).toBe(512 * MIB);
  });

  it('refuses a cap that is not a positive whole number of bytes', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createBodyCapPolicy({ defaultBytes: bad })).toThrow(RangeError);
      expect(() => createBodyCapPolicy({ overrides: { k: bad } })).toThrow(RangeError);
    }
  });
});

describe('readBody', () => {
  it('keeps a small body in memory and writes no file', async () => {
    const result = await readBody(pattern(1000, 300), {
      capBytes: 10_000,
      spoolDir: dir,
      spoolThresholdBytes: 4096,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.size).toBe(1000);
    expect(result.body.sha256).toBe(sha(expectedPattern(1000)));
    expect(await readAll(result.body)).toEqual(expectedPattern(1000));
    expect(await readAll(result.body)).toEqual(expectedPattern(1000));
    expect(await spooled()).toEqual([]);
  });

  it('spools a body past the threshold, hashes it, and reads it again for each attempt', async () => {
    const result = await readBody(pattern(5000, 700), {
      capBytes: 10_000,
      spoolDir: dir,
      spoolThresholdBytes: 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.size).toBe(5000);
    expect(result.body.sha256).toBe(sha(expectedPattern(5000)));
    const files = await spooled();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`${SPOOL_SUFFIX.replace('.', '\\.')}$`));
    expect(((await stat(join(dir, files[0] as string))).mode & 0o777).toString(8)).toBe('600');
    expect(await readAll(result.body)).toEqual(expectedPattern(5000));
    expect(await readAll(result.body)).toEqual(expectedPattern(5000));
    await result.body.dispose();
    expect(await spooled()).toEqual([]);
    await result.body.dispose();
    expect(() => result.body.open()).toThrow('disposed');
  });

  it('copes with an empty body', async () => {
    const result = await readBody(pattern(0, 10), { capBytes: 10, spoolDir: dir });
    expect(result.ok && result.body.size).toBe(0);
    expect(result.ok && result.body.sha256).toBe(sha(Buffer.alloc(0)));
  });

  it.each([
    ['in memory', 4096],
    ['spooled', 100],
  ])('accepts a body of exactly the cap (%s)', async (_, threshold) => {
    const result = await readBody(pattern(1000, 150), {
      capBytes: 1000,
      spoolDir: dir,
      spoolThresholdBytes: threshold,
    });
    expect(result.ok).toBe(true);
    if (result.ok) await result.body.dispose();
  });

  it.each([
    ['in memory', 4096],
    ['spooled', 100],
  ])(
    'refuses a body one byte over the cap and leaves nothing behind (%s)',
    async (_, threshold) => {
      const result = await readBody(pattern(1001, 150), {
        capBytes: 1000,
        spoolDir: dir,
        spoolThresholdBytes: threshold,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'too-large',
        refusal: { code: 'body-too-large', status: 413 },
      });
      expect(await spooled()).toEqual([]);
    }
  );

  it('stops reading as soon as the cap is passed', async () => {
    let chunks = 0;
    const result = await readBody(
      pattern(10_000_000, 100, () => {
        chunks += 1;
      }),
      { capBytes: 1000, spoolDir: dir }
    );
    expect(result.ok).toBe(false);
    expect(chunks).toBeLessThan(20);
  });

  it('refuses a declared length over the cap without reading the body', async () => {
    let touched = false;
    const source = (async function* () {
      touched = true;
      yield new Uint8Array(1);
    })();
    const result = await readBody(source, { capBytes: 1000, spoolDir: dir, declaredLength: 1001 });
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
    expect(touched).toBe(false);
  });

  it('removes the spool file when the source fails part way', async () => {
    const source = (async function* () {
      yield new Uint8Array(500).fill(1);
      yield new Uint8Array(500).fill(2);
      throw new Error('connection reset');
    })();
    const result = await readBody(source, {
      capBytes: 10_000,
      spoolDir: dir,
      spoolThresholdBytes: 100,
    });
    expect(result).toMatchObject({ ok: false, reason: 'read-error' });
    expect(await spooled()).toEqual([]);
  });

  it('removes the spool file when the request is killed part way', async () => {
    const controller = new AbortController();
    const source = Readable.from(
      (async function* () {
        for (let i = 0; i < 100; i += 1) {
          if (i === 3) controller.abort();
          yield new Uint8Array(500).fill(i);
          await new Promise((r) => setTimeout(r, 2));
        }
      })()
    );
    const result = await readBody(source, {
      capBytes: 1_000_000,
      spoolDir: dir,
      spoolThresholdBytes: 100,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(await spooled()).toEqual([]);
  });

  it('refuses at once when the request was already killed', async () => {
    const result = await readBody(pattern(10, 10), {
      capBytes: 100,
      spoolDir: dir,
      signal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
  });

  it('fails with a retryable internal error when the spool directory is unusable', async () => {
    const result = await readBody(pattern(5000, 500), {
      capBytes: 10_000,
      spoolDir: join(dir, 'missing'),
      spoolThresholdBytes: 100,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'spool-error',
      refusal: { code: 'internal-error', status: 503 },
    });
  });

  it('rejects nonsense limits', async () => {
    await expect(readBody(pattern(1, 1), { capBytes: 0, spoolDir: dir })).rejects.toThrow(
      RangeError
    );
    await expect(
      readBody(pattern(1, 1), { capBytes: 1, spoolDir: dir, spoolThresholdBytes: 0 })
    ).rejects.toThrow(RangeError);
  });
});

describe('withBody', () => {
  const options = () => ({ capBytes: 10_000, spoolDir: dir, spoolThresholdBytes: 100 });

  it('removes the spool file after the work succeeds', async () => {
    const out = await withBody(pattern(5000, 500), options(), async (body) => {
      expect(await spooled()).toHaveLength(1);
      return body.size;
    });
    expect(out).toEqual({ ok: true, value: 5000 });
    expect(await spooled()).toEqual([]);
  });

  it('removes the spool file after the work fails', async () => {
    await expect(
      withBody(pattern(5000, 500), options(), async () => {
        throw new Error('upstream failed');
      })
    ).rejects.toThrow('upstream failed');
    expect(await spooled()).toEqual([]);
  });

  it('never runs the work for a refused body', async () => {
    let called = false;
    const out = await withBody(pattern(20_000, 500), options(), async () => {
      called = true;
    });
    expect(out).toMatchObject({ ok: false, reason: 'too-large' });
    expect(called).toBe(false);
    expect(await spooled()).toEqual([]);
  });
});

describe('clearSpoolDir', () => {
  it('removes spool files an earlier process left and nothing else', async () => {
    await writeFile(join(dir, `a${SPOOL_SUFFIX}`), 'x');
    await writeFile(join(dir, `b${SPOOL_SUFFIX}`), 'y');
    await writeFile(join(dir, 'keep.txt'), 'z');
    expect(await clearSpoolDir(dir)).toBe(2);
    expect(await spooled()).toEqual(['keep.txt']);
  });

  it('creates a missing directory', async () => {
    const fresh = join(dir, 'nested', 'spool');
    expect(await clearSpoolDir(fresh)).toBe(0);
    expect(((await stat(fresh)).mode & 0o777).toString(8)).toBe('700');
  });
});

describe('a body at the default ceiling', () => {
  const total = DEFAULT_BODY_CAP_BYTES;

  it('is accepted with memory staying flat, then removed', async () => {
    const baseline = process.memoryUsage();
    let peak = 0;
    const sample = (): void => {
      const m = process.memoryUsage();
      peak = Math.max(
        peak,
        m.heapUsed + m.arrayBuffers - baseline.heapUsed - baseline.arrayBuffers
      );
    };
    const result = await readBody(pattern(total, MIB, sample), {
      capBytes: DEFAULT_BODY_CAP_BYTES,
      spoolDir: dir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.size).toBe(total);
    expect(peak).toBeLessThan(32 * MIB);
    const hash = createHash('sha256');
    for await (const c of pattern(total, MIB)) hash.update(c);
    expect(result.body.sha256).toBe(hash.digest('hex'));
    expect((await stat(join(dir, (await spooled())[0] as string))).size).toBe(total);
    await result.body.dispose();
    expect(await spooled()).toEqual([]);
  }, 60_000);

  it('is refused one byte over, with nothing left on disk', async () => {
    const result = await readBody(pattern(total + 1, MIB), {
      capBytes: DEFAULT_BODY_CAP_BYTES,
      spoolDir: dir,
    });
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await spooled()).toEqual([]);
  }, 60_000);
});
