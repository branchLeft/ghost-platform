export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * One JSON object per line to stdout — never a bare console call, and never
 * an API key, message body or full recipient address (see callers: the
 * worker logs a recipient's domain only, the CLI never routes through this
 * at all).
 */
export function createLogger(write: (line: string) => void = defaultWrite): Logger {
  function log(level: LogLevel, event: string, fields: LogFields = {}): void {
    write(JSON.stringify({ ts: new Date().toISOString(), level, event, fields }));
  }

  return {
    log,
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

function defaultWrite(line: string): void {
  process.stdout.write(line + '\n');
}
