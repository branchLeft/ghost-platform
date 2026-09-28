import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * The break-glass token is minted by the operator, where the signing key
 * lives, and handed to this process -- this package holds no key and
 * mints nothing. It is asked for only once the export colour is up,
 * because the adapter refuses a token issued before the Ghost process
 * that receives it started.
 */
export interface BreakGlassTokenSource {
  obtain(): Promise<string>;
}

export class InvalidBreakGlassTokenError extends Error {
  constructor(detail: string) {
    super(`break-glass token refused before use: ${detail}`);
    this.name = 'InvalidBreakGlassTokenError';
  }
}

// `<base64url claims>.<base64url Ed25519 signature>`; a 64-byte signature
// is always 86 base64url characters.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{86}$/;

export function assertTokenShape(token: string): void {
  // The token itself is never repeated in an error: it may still be live.
  if (!TOKEN_SHAPE.test(token)) {
    throw new InvalidBreakGlassTokenError('not a <claims>.<signature> break-glass token');
  }
}

/**
 * Writes `prompt` to `output`, then reads exactly one line from `input` and
 * releases it.
 */
export function createPromptedTokenSource(
  input: Readable,
  output: Writable,
  prompt: string
): BreakGlassTokenSource {
  return {
    obtain() {
      return new Promise((resolve, reject) => {
        const rl = createInterface({ input, terminal: false });
        let settled = false;
        rl.once('line', (line) => {
          settled = true;
          rl.close();
          // Closing readline only pauses the input; a paused FIFO or pipe
          // on stdin still holds the event loop open after the export ends.
          input.destroy();
          const token = line.trim();
          try {
            assertTokenShape(token);
            resolve(token);
          } catch (err) {
            reject(err);
          }
        });
        rl.once('close', () => {
          if (!settled)
            reject(new InvalidBreakGlassTokenError('input closed before a token was given'));
        });
        output.write(`${prompt}\n`);
      });
    },
  };
}
