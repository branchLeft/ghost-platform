import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildRefusalError } = require('../../src/refusal-error.js');
const GhostErrors = require('@tryghost/errors');

describe('buildRefusalError', () => {
  it('is a typed UnsupportedMediaTypeError with a 415 status, never a plain Error', () => {
    const err = buildRefusalError(GhostErrors, { classification: 'harmful-abusive-material' });
    expect(err).toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
    expect(err.statusCode).toBe(415);
    expect(err.errorType).toBe('UnsupportedMediaTypeError');
  });

  it('names no classification when the match is csam', () => {
    const err = buildRefusalError(GhostErrors, { classification: 'csam' });
    expect(err.context).not.toMatch(/csam/);
    expect(err.message).not.toMatch(/csam/);
  });

  it('names the classification for every other match', () => {
    const err = buildRefusalError(GhostErrors, { classification: 'harmful-abusive-material' });
    expect(err.context).toMatch(/harmful-abusive-material/);
  });

  it('names the classification for the test route too', () => {
    const err = buildRefusalError(GhostErrors, { classification: 'test' });
    expect(err.context).toMatch(/\btest\b/);
  });
});
