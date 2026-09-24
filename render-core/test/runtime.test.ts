import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RSS_BUDGET_MIB,
  DEFAULT_UPLOAD_CEILING_MIB,
  uploadLimits,
} from '../src/runtime.js';

describe('uploadLimits()', () => {
  it('derives every limit from the default ceiling when called with no arguments', () => {
    const limits = uploadLimits();
    expect(limits.tmpfsSize).toBe(`${DEFAULT_UPLOAD_CEILING_MIB}m`);
    expect(limits.themeCompressedBytes).toBe((DEFAULT_UPLOAD_CEILING_MIB / 4) * 1024 * 1024);
    expect(limits.edgeRequestBodyMaxSize).toBe(`${DEFAULT_UPLOAD_CEILING_MIB / 2}MiB`);
    expect(limits.memoryLimit).toBe(`${DEFAULT_RSS_BUDGET_MIB + DEFAULT_UPLOAD_CEILING_MIB}m`);
  });

  it('rejects a ceiling below the minimum', () => {
    expect(() => uploadLimits(8)).toThrow(/at least/);
  });

  it('rejects a ceiling not a multiple of 4', () => {
    expect(() => uploadLimits(17)).toThrow(/multiple of/);
  });

  it('rejects a non-positive rss budget', () => {
    expect(() => uploadLimits(128, 0)).toThrow(/positive integer/);
  });

  it('accepts a custom, valid ceiling and rss budget', () => {
    const limits = uploadLimits(64, 256);
    expect(limits.tmpfsSize).toBe('64m');
    expect(limits.memoryLimit).toBe('320m');
  });
});
