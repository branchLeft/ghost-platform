import { describe, expect, it } from 'vitest';
import type { RefusalCode } from '../src/contracts.js';
import { refusal, refusalBody } from '../src/refusal.js';

const CODES: RefusalCode[] = [
  'internal-error',
  'signature-refused',
  'credential-not-active',
  'credential-invalid',
  'operation-not-allowed',
  'target-malformed',
  'bucket-not-allowed',
  'key-outside-folder',
  'upload-not-bound',
  'body-too-large',
  'upstream-timeout',
  'upstream-unavailable',
  'upstream-throttled',
];

describe('refusal', () => {
  it.each(CODES)('%s has a clear message and a status that is an error', (code) => {
    const r = refusal(code);
    expect(r.code).toBe(code);
    expect(r.message.length).toBeGreaterThan(10);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('answers a malformed target with 400, a policy refusal with 403, a failure with 503', () => {
    expect(refusal('target-malformed').status).toBe(400);
    expect(refusal('key-outside-folder').status).toBe(403);
    expect(refusal('internal-error').status).toBe(503);
  });

  it('renders an S3-style error body that SDK clients can parse', () => {
    expect(refusalBody(refusal('operation-not-allowed'))).toContain('<Code>AccessDenied</Code>');
    expect(refusalBody(refusal('target-malformed'))).toContain('<Code>InvalidURI</Code>');
    expect(refusalBody(refusal('internal-error'))).toContain('<Code>ServiceUnavailable</Code>');
  });

  it('answers an oversized body with 413 and the code the SDK reports as too large', () => {
    expect(refusal('body-too-large').status).toBe(413);
    expect(refusalBody(refusal('body-too-large'))).toContain('<Code>EntityTooLarge</Code>');
  });

  it('answers the storage service being slow or busy with a status and code the SDK retries', () => {
    expect(refusal('upstream-timeout').status).toBe(504);
    expect(refusalBody(refusal('upstream-timeout'))).toContain('<Code>RequestTimeout</Code>');
    expect(refusal('upstream-throttled').status).toBe(503);
    expect(refusalBody(refusal('upstream-throttled'))).toContain('<Code>SlowDown</Code>');
    expect(refusalBody(refusal('upstream-unavailable'))).toContain(
      '<Code>ServiceUnavailable</Code>'
    );
  });
});
