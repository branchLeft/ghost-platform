import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildVideoAudioRefusedError,
  VIDEO_AUDIO_REFUSED_MESSAGE,
  VIDEO_AUDIO_REFUSED_CONTEXT,
} = require('../../src/refusal-error.js');
const { ScannerMetrics, REFUSAL_REASONS } = require('../../src/metrics.js');
const GhostErrors = require('@tryghost/errors');

describe('buildVideoAudioRefusedError', () => {
  it('is a typed UnsupportedMediaTypeError with a 415 status, never a plain Error', () => {
    const error = buildVideoAudioRefusedError(GhostErrors);
    expect(error).toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
    expect(error.statusCode).toBe(415);
    expect(error.errorType).toBe('UnsupportedMediaTypeError');
  });

  it('carries the placeholder wording, to be replaced by the owner', () => {
    expect(VIDEO_AUDIO_REFUSED_MESSAGE).toBe('VIDEO_AUDIO_REFUSED_MESSAGE_PLACEHOLDER');
    expect(VIDEO_AUDIO_REFUSED_CONTEXT).toBe('VIDEO_AUDIO_REFUSED_CONTEXT_PLACEHOLDER');
    const error = buildVideoAudioRefusedError(GhostErrors);
    expect(error.message).toBe(VIDEO_AUDIO_REFUSED_MESSAGE);
    expect(error.context).toBe(VIDEO_AUDIO_REFUSED_CONTEXT);
  });
});

describe('the video-audio refusal reason in the metrics registry', () => {
  it('is a declared reason, written at zero from the first render', () => {
    expect(REFUSAL_REASONS).toContain('video-audio');
    const text = new ScannerMetrics({ tenant: 'TENANT_PLACEHOLDER' }).render();
    expect(text).toContain(
      'scanning_storage_uploads_refused_total{tenant="TENANT_PLACEHOLDER",reason="video-audio"} 0'
    );
  });

  it('counts a refusal under its own label and no other', () => {
    const metrics = new ScannerMetrics({ tenant: 'TENANT_PLACEHOLDER' });
    metrics.recordRefusal('video-audio');
    metrics.recordRefusal('video-audio');
    const text = metrics.render();
    expect(text).toContain('reason="video-audio"} 2');
    expect(text).toContain('reason="verdict"} 0');
    expect(text).toContain('reason="unconfigured"} 0');
    expect(text).toContain('reason="sealed"} 0');
  });
});
