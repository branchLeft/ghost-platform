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
 * One JSON object per line to stdout -- never a bare console call, and never
 * a drain token, SMTP credential or message body: callers log a message id
 * and a target id, never the fields a leaked line would make useful to
 * replay against mx1 or a drained host.
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
