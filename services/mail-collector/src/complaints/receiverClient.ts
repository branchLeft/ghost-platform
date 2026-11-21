import { readFileSync } from 'node:fs';

/** One verified complaint as the receiver queues it. Nothing else is stored there: no recipient, no body. */
export interface QueuedComplaint {
  seq: number;
  outcomeId: string;
  class: string;
  /** Receive time at the receiver, epoch seconds. */
  at: number;
}

export interface ReceiverClient {
  /** `GET /drain`: records past the receiver's last acknowledgement, oldest first. */
  pull(limit: number, signal?: AbortSignal): Promise<QueuedComplaint[]>;
  /** `POST /drain/ack`: releases records up to and including `through`. Called only once they are handled. */
  ack(through: number, signal?: AbortSignal): Promise<void>;
}

export interface ReceiverClientOptions {
  /** The receiver's private drain address, e.g. `http://10.0.0.5:9000`. We dial it; it never dials us. */
  baseUrl: string;
  /** Path of the file holding the drain bearer token. Read for each call and never held. */
  tokenFile: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** A failure whose message names a step and a status only, never the token, the body or the address. */
export class ReceiverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiverError';
  }
}

function readToken(tokenFile: string): string {
  let raw: string;
  try {
    raw = readFileSync(tokenFile, 'utf8');
  } catch {
    throw new ReceiverError('receiver token file unreadable');
  }
  const token = raw.replace(/[\r\n]+$/, '');
  if (token === '') {
    throw new ReceiverError('receiver token file is empty');
  }
  return token;
}

function isComplaint(value: unknown): value is QueuedComplaint {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.seq === 'number' &&
    Number.isSafeInteger(v.seq) &&
    v.seq > 0 &&
    typeof v.outcomeId === 'string' &&
    typeof v.class === 'string' &&
    typeof v.at === 'number' &&
    Number.isFinite(v.at)
  );
}

/**
 * The collector's only way into the Sweego complaint receiver: the two drain
 * routes, bearer-authenticated, over the private network. The token is read
 * from its file for each call so a rotation needs no restart and no copy of it
 * lives in this object. Failures are thrown as `ReceiverError`.
 */
export function createReceiverClient(opts: ReceiverClientOptions): ReceiverClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${readToken(opts.tokenFile)}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
    } catch (error) {
      if (error instanceof ReceiverError) {
        throw error;
      }
      // Only the class of the failure: a transport error can quote the address.
      throw new ReceiverError(`${method} ${path} failed: ${(error as Error).name}`);
    }
    if (!res.ok) {
      throw new ReceiverError(`${method} ${path} -> ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new ReceiverError(`${method} ${path} answered a body that is not JSON`);
    }
  }

  return {
    async pull(limit, signal) {
      const body = await call('GET', `/drain?limit=${limit}`, undefined, signal);
      const records = (body as { records?: unknown } | null)?.records;
      if (!Array.isArray(records) || !records.every(isComplaint)) {
        throw new ReceiverError('GET /drain answered a shape that is not a record list');
      }
      return records;
    },
    async ack(through, signal) {
      await call('POST', '/drain/ack', { through }, signal);
    },
  };
}
