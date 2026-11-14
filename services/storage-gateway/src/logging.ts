import { AsyncLocalStorage } from 'node:async_hooks';
import type { GatewayLogger, RefusalLogEntry } from './admit.js';
import type { AdminLogEntry, AdminLogger } from './credentials/admin.js';
import type { UpstreamLogEntry } from './upstream.js';

/** One line of structured output. Every value is a string, number or boolean. */
export type LogLine = Readonly<Record<string, string | number | boolean>>;

export type LogSink = (line: string) => void;

export interface RequestContext {
  readonly requestId: string;
}

/** Carries the request id to the library's loggers, which know nothing about requests. */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The line a finished request leaves behind. It names no object key, bucket or target. */
export interface RequestLogEntry {
  readonly event: 'request';
  readonly method: string;
  readonly status: number;
  readonly durationMs: number;
  readonly keyId?: string;
  readonly operation?: string;
  readonly bytesIn?: number;
}

export interface ServiceLogEntry {
  readonly event: 'service';
  readonly message: string;
  readonly detail?: string;
}

export interface GatewayLog extends GatewayLogger, AdminLogger {
  upstream(entry: UpstreamLogEntry): void;
  request(entry: RequestLogEntry): void;
  service(entry: ServiceLogEntry): void;
}

/**
 * Writes one JSON object per line. Each logger method copies named fields
 * from its entry; it never spreads an entry, so a field added to a library
 * entry later does not reach the log until it is named here.
 */
export function createLog(sink: LogSink, now: () => number = Date.now): GatewayLog {
  const emit = (line: LogLine): void => {
    const requestId = requestContext.getStore()?.requestId;
    const out: Record<string, string | number | boolean> = {
      time: new Date(now()).toISOString(),
      ...line,
      ...(requestId === undefined ? {} : { requestId }),
    };
    try {
      sink(JSON.stringify(out));
    } catch {
      // A sink that fails must never fail a request.
    }
  };
  const defined = (pairs: Record<string, string | number | undefined>): LogLine => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(pairs)) if (v !== undefined) out[k] = v;
    return out;
  };

  return {
    refusal(e: RefusalLogEntry): void {
      emit({
        event: e.event,
        code: e.code,
        status: e.status,
        method: e.method,
        ...defined({ keyId: e.keyId, folder: e.folder, operation: e.operation }),
      });
    },
    admin(e: AdminLogEntry): void {
      emit({
        event: e.event,
        caller: e.caller,
        operation: e.operation,
        at: e.at,
        folder: e.folder,
        ...defined({ keyId: e.keyId, changed: e.changed }),
      });
    },
    upstream(e: UpstreamLogEntry): void {
      emit({
        event: e.event,
        outcome: e.outcome,
        operation: e.operation,
        keyId: e.keyId,
        attempts: e.attempts,
        elapsedMs: e.elapsedMs,
        ...defined({ status: e.status }),
      });
    },
    request(e: RequestLogEntry): void {
      emit({
        event: e.event,
        method: e.method,
        status: e.status,
        durationMs: e.durationMs,
        ...defined({ keyId: e.keyId, operation: e.operation, bytesIn: e.bytesIn }),
      });
    },
    service(e: ServiceLogEntry): void {
      emit({ event: e.event, message: e.message, ...defined({ detail: e.detail }) });
    },
  };
}
