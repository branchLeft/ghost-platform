/** The most text one host's exporter may send. A host with a handful of tenants sends a few kilobytes. */
export const MAX_SCRAPE_BYTES = 1024 * 1024;

/**
 * Reads a stream to its end as UTF-8 text, or returns null when it is longer
 * than `maxBytes`: a stream that will not stop is not read further, and what was
 * read is not used.
 */
export async function readScrape(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number = MAX_SCRAPE_BYTES
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += bytes.length;
    if (size > maxBytes) return null;
    chunks.push(bytes);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}
