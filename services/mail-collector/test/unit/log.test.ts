import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/log.js';

describe('createLogger', () => {
  it('writes one JSON object per line via the supplied write function', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log.info('something_happened', { foo: 'bar' });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({
      level: 'info',
      event: 'something_happened',
      fields: { foo: 'bar' },
    });
    expect(typeof parsed.ts).toBe('string');
  });

  it('warn() and error() set the right level, and fields default to {}', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log.warn('w');
    log.error('e');
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', event: 'w', fields: {} });
    expect(JSON.parse(lines[1]!)).toMatchObject({ level: 'error', event: 'e', fields: {} });
  });

  it('defaults to writing to stdout when no write function is supplied', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const log = createLogger();
      log.info('default_write_path');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toContain('default_write_path');
    } finally {
      spy.mockRestore();
    }
  });
});
