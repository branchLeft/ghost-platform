import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_SCRAPE_BYTES, readScrape } from '../src/collector/readScrape.js';

describe('reading the exporter text from standard input', () => {
  it('joins the chunks and decodes them as text', async () => {
    const text = await readScrape(Readable.from([Buffer.from('abc\n'), 'def\n']));
    expect(text).toBe('abc\ndef\n');
  });

  it('reads an empty stream as empty text', async () => {
    expect(await readScrape(Readable.from([]))).toBe('');
  });

  it('takes a stream of exactly the limit and refuses one byte more', async () => {
    expect(await readScrape(Readable.from([Buffer.alloc(8, 97)]), 8)).toBe('aaaaaaaa');
    expect(await readScrape(Readable.from([Buffer.alloc(9, 97)]), 8)).toBeNull();
  });

  it('refuses a stream that goes past the limit over several chunks, without waiting for its end', async () => {
    async function* endless(): AsyncGenerator<Buffer> {
      for (;;) yield Buffer.alloc(1024, 97);
    }
    expect(await readScrape(endless(), 4096)).toBeNull();
  });

  it('allows a megabyte by default', () => {
    expect(MAX_SCRAPE_BYTES).toBe(1024 * 1024);
  });
});
