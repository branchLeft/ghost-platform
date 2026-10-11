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

describe('buildScannerUnconfiguredError', () => {
  const { buildScannerUnconfiguredError } = require('../../src/refusal-error.js');

  it('is a typed 503 MaintenanceError, never a plain Error and never a 415', () => {
    const err = buildScannerUnconfiguredError(GhostErrors);
    expect(err).toBeInstanceOf(GhostErrors.MaintenanceError);
    expect(err.statusCode).toBe(503);
  });

  it('says the safety check is not configured and names no classification', () => {
    const err = buildScannerUnconfiguredError(GhostErrors);
    expect(err.message).toMatch(/not configured/);
    expect(err.context).not.toMatch(/flagged|csam|harmful/);
  });
});

describe('buildVerdictPendingError', () => {
  const { buildVerdictPendingError } = require('../../src/refusal-error.js');

  it('is a typed 503 MaintenanceError that names no classification', () => {
    const err = buildVerdictPendingError(GhostErrors);
    expect(err).toBeInstanceOf(GhostErrors.MaintenanceError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/not answered/);
    expect(err.context).not.toMatch(/flagged|csam|harmful/);
  });
});

describe('buildUncheckableError', () => {
  const { buildUncheckableError } = require('../../src/refusal-error.js');

  it('is a typed 415 UnsupportedMediaTypeError that names no classification', () => {
    const err = buildUncheckableError(GhostErrors);
    expect(err).toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
    expect(err.statusCode).toBe(415);
    expect(err.context).not.toMatch(/flagged|csam|harmful/);
  });
});
