import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  assertTokenShape,
  createPromptedTokenSource,
  InvalidBreakGlassTokenError,
} from '../../src/operatorToken.js';

const SIGNATURE = 'A'.repeat(86);
const TOKEN = `eyJzdWIiOiJ4In0.${SIGNATURE}`;

function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString('utf8');
}

describe('assertTokenShape', () => {
  it('accepts <base64url claims>.<86-character signature>', () => {
    expect(() => assertTokenShape(TOKEN)).not.toThrow();
  });

  it.each([
    [''],
    ['no-dot'],
    [`claims.${'A'.repeat(85)}`],
    [`claims.${'A'.repeat(87)}`],
    [`cla ims.${SIGNATURE}`],
    [`claims.${SIGNATURE}.extra`],
    [`https://tenant.example/ghost/?bl_break_glass=claims.${SIGNATURE}`],
  ])('refuses %j without repeating it', (token) => {
    let caught: unknown;
    try {
      assertTokenShape(token);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidBreakGlassTokenError);
    if (token.length > 0) expect((caught as Error).message).not.toContain(token);
  });
});

describe('createPromptedTokenSource', () => {
  it('writes the prompt, then resolves with the one line given, trimmed', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = collect(output);
    const pending = createPromptedTokenSource(input, output, 'paste a token:').obtain();
    input.write(`  ${TOKEN}  \n`);
    await expect(pending).resolves.toBe(TOKEN);
    expect(written()).toBe('paste a token:\n');
  });

  it('releases the input after the one line, so a pipe on stdin cannot keep the process alive', async () => {
    const input = new PassThrough();
    const pending = createPromptedTokenSource(input, new PassThrough(), 'p').obtain();
    input.write(`${TOKEN}\n`);
    await pending;
    expect(input.destroyed).toBe(true);
  });

  it('asks only when obtain() is called -- never before the colour is up', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = collect(output);
    const source = createPromptedTokenSource(input, output, 'paste a token:');
    await new Promise((r) => setImmediate(r));
    expect(written()).toBe('');
    const pending = source.obtain();
    input.write(`${TOKEN}\n`);
    await expect(pending).resolves.toBe(TOKEN);
  });

  it('refuses a malformed line with InvalidBreakGlassTokenError', async () => {
    const input = new PassThrough();
    const pending = createPromptedTokenSource(input, new PassThrough(), 'p').obtain();
    input.write('not a token\n');
    await expect(pending).rejects.toThrow(InvalidBreakGlassTokenError);
  });

  it('refuses when input closes before any line arrives', async () => {
    const input = new PassThrough();
    const pending = createPromptedTokenSource(input, new PassThrough(), 'p').obtain();
    input.end();
    await expect(pending).rejects.toThrow(/input closed before a token was given/);
  });
});
