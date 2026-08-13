import type { LogFields, LogLevel, Logger } from '../../src/log.js';
import { createLogger } from '../../src/log.js';

export interface CapturedLogLine {
  ts: string;
  level: LogLevel;
  event: string;
  fields: LogFields;
}

export interface TestLogger {
  logger: Logger;
  lines: CapturedLogLine[];
}

/** Captures every log line as a parsed object instead of writing to stdout, so tests can assert on log content directly. */
export function createTestLogger(): TestLogger {
  const lines: CapturedLogLine[] = [];
  const logger = createLogger((line) => {
    lines.push(JSON.parse(line) as CapturedLogLine);
  });
  return { logger, lines };
}
