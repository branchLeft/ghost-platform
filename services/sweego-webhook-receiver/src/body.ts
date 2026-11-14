import type { IncomingMessage } from 'node:http';

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body over the cap');
  }
}

/**
 * Collects the request body, counting bytes as they arrive. The declared
 * length is checked first so an oversized request is refused before a byte
 * is buffered, and the running count is checked again because a declared
 * length can lie or be absent (chunked).
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (
      declared !== undefined &&
      (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > maxBytes)
    ) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request aborted')));
  });
}
