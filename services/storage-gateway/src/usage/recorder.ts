import type { RoutedRequest } from '../router.js';
import type { SqliteWriteLedger } from './ledger.js';
import type { UsageMeter } from './meter.js';

export interface UsageTenant {
  readonly keyId: string;
  readonly folder: string;
  readonly bucket: string;
}

export interface UsageRecorderOptions {
  readonly ledger: SqliteWriteLedger;
  readonly meter: UsageMeter;
  /** ISO 8601 UTC time of now; injectable for tests. */
  readonly now?: () => string;
}

export interface WriteIntent {
  readonly tenant: UsageTenant;
  readonly route: RoutedRequest;
  /** Bytes in the request body the gateway received. */
  readonly bodySize: number;
}

export interface CallOutcome extends WriteIntent {
  /** The status the gateway answered with. */
  readonly status: number;
  /** Bytes sent back to the client in the response body. */
  readonly responseBytes: number;
}

/**
 * Ties the meter and the write ledger to a request's life. The caller makes
 * two calls around the upstream call: {@link beforeUpstream}, whose failure
 * means the request must not be sent, and {@link afterUpstream}.
 */
export class UsageRecorder {
  readonly #ledger: SqliteWriteLedger;
  readonly #meter: UsageMeter;
  readonly #now: () => string;

  constructor(options: UsageRecorderOptions) {
    this.#ledger = options.ledger;
    this.#meter = options.meter;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Records an object name in the ledger before the write is sent, because
   * the storage service can commit a write and still lose the answer: a name
   * recorded for a write that failed is harmless, a name missing for one that
   * landed would hide an object from an erasure. Throws if the row cannot be
   * saved; the caller must then refuse the request.
   */
  beforeUpstream({ tenant, route, bodySize }: WriteIntent): void {
    const { operation, key, uploadId } = route;
    if (operation !== 'PutObject' && operation !== 'CompleteMultipartUpload') return;
    const size =
      operation === 'PutObject' || uploadId === undefined
        ? bodySize
        : this.#ledger.sumParts(tenant.keyId, uploadId);
    this.#ledger.recordWrite({
      keyId: tenant.keyId,
      folder: tenant.folder,
      bucket: tenant.bucket,
      objectKey: key,
      size,
      operation,
      writtenAt: this.#now(),
    });
  }

  /** Counts the request, and its billable bytes when it succeeded, and keeps multipart sizes. */
  afterUpstream({ tenant, route, bodySize, status, responseBytes }: CallOutcome): void {
    const succeeded = status >= 200 && status < 300;
    this.#meter.record(
      tenant.keyId,
      route.operation,
      succeeded ? bodySize : 0,
      succeeded ? responseBytes : 0
    );
    if (!succeeded || route.uploadId === undefined) return;
    if (route.operation === 'UploadPart' && route.partNumber !== undefined) {
      this.#ledger.addPart(tenant.keyId, route.uploadId, route.partNumber, bodySize);
    } else if (
      route.operation === 'CompleteMultipartUpload' ||
      route.operation === 'AbortMultipartUpload'
    ) {
      this.#ledger.clearParts(tenant.keyId, route.uploadId);
    }
  }
}
