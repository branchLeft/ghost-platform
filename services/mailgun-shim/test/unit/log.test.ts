import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.js';

describe('createLogger', () => {
  it('writes one JSON line per call with ts/level/event/fields', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.info('enqueue', { domain: 'tenant.example.com', batchId: 'b1', recipientCount: 3 });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as {
      ts: string;
      level: string;
      event: string;
      fields: unknown;
    };
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('enqueue');
    expect(parsed.fields).toEqual({
      domain: 'tenant.example.com',
      batchId: 'b1',
      recipientCount: 3,
    });
    expect(() => new Date(parsed.ts).toISOString()).not.toThrow();
  });

  it('supports warn and error levels, and defaults fields to an empty object', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.warn('throttle_reload');
    logger.error('tick_failed');

    const parsed = lines.map(
      (line) => JSON.parse(line) as { level: string; event: string; fields: unknown }
    );
    expect(parsed[0]!.level).toBe('warn');
    expect(parsed[0]!.fields).toEqual({});
    expect(parsed[1]!.level).toBe('error');
    expect(parsed[1]!.event).toBe('tick_failed');
  });

  it('the generic log() method accepts an explicit level', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.log('warn', 'custom_event', { a: 1 });
    const parsed = JSON.parse(lines[0]!) as { level: string };
    expect(parsed.level).toBe('warn');
  });

  it('defaults to writing to stdout when no write function is given', () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      createLogger().info('default_write');
    } finally {
      process.stdout.write = original;
    }
    expect(written.some((line) => line.includes('default_write'))).toBe(true);
  });
});
