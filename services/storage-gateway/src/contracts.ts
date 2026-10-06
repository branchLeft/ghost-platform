/**
 * The seams of the storage gateway. The router and folder guard produce a
 * {@link GatewayRequest} and consume {@link SignatureVerifier} and
 * {@link CredentialStore}; the signature check and the credential store each
 * implement one. Extend these shapes rather than reshaping them.
 */

/**
 * One inbound HTTP request, exactly as the gateway received it, before any
 * decoding or normalisation. Both the verifier and the router read this
 * model; neither may rely on the other having cleaned it up.
 */
export interface GatewayRequest {
  /** Upper-case HTTP method, for example `PUT`. */
  readonly method: string;

  /**
   * The raw request target: path and query string byte for byte as sent,
   * with percent-encoding intact (`/bucket/folder/a%20b.png?uploadId=x`).
   * A signature is computed over this form, so it must never be decoded
   * before the verifier sees it.
   */
  readonly rawTarget: string;

  /**
   * Request headers with lower-cased names. A repeated header is carried as
   * an array in arrival order, never merged or dropped.
   */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** Why a request was refused. Stable strings: they are logged and tested. */
export type RefusalCode =
  /** A dependency (verifier or credential store) failed; the gateway fails closed. */
  | 'internal-error'
  /** The signature check refused the request (unsigned, presigned, bad signature, unknown key). */
  | 'signature-refused'
  /** The credential exists but is not currently usable (see {@link CredentialState}). */
  | 'credential-not-active'
  /** The credential record is malformed, for example an empty or multi-segment folder. */
  | 'credential-invalid'
  /** The request is not one of the seven shapes Ghost sends. */
  | 'operation-not-allowed'
  /** The request target is malformed or uses an encoding trick. */
  | 'target-malformed'
  /** The request names a bucket other than the tenant's assigned bucket. */
  | 'bucket-not-allowed'
  /** The object key is outside the tenant's folder. */
  | 'key-outside-folder';

/** A refusal: always carries a code, a client-safe message and an HTTP status. */
export interface Refusal {
  readonly code: RefusalCode;
  /** Safe to return to the caller: never names a folder, bucket or key. */
  readonly message: string;
  /** The HTTP status the gateway answers with: 4xx for a refused request, 5xx for a failure. */
  readonly status: number;
}

/** The outcome of a signature check. */
export type VerifyResult =
  | {
      readonly ok: true;
      /** The tenant's key id, taken from the verified signature's credential scope. */
      readonly keyId: string;
    }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * Checks that a request was signed by a tenant key and says which one.
 * Implementations accept only header-signed requests with a signed payload
 * hash; unsigned, streaming, presigned and SigV2 requests are refusals.
 */
export interface SignatureVerifier {
  verify(request: GatewayRequest): Promise<VerifyResult>;
}

/** Whether a tenant credential may currently be used. */
export type CredentialState =
  /** Normal operation. */
  | 'active'
  /** Switched off by an operator (a kill switch); every request is refused. */
  | 'disabled'
  /** Permanently withdrawn, for example after tenant departure. */
  | 'revoked';

/** What a key id is allowed to touch. */
export interface CredentialRecord {
  /**
   * The tenant's opaque folder: one path segment, never the tenant's slug
   * and never containing `/`. Every object key must sit inside it.
   */
  readonly folder: string;
  /** The one shared bucket this tenant's folder lives in. */
  readonly bucket: string;
  readonly state: CredentialState;
}

/**
 * Maps a verified key id to the tenant's folder, bucket and state. Resolves
 * to `undefined` for a key id the store has never issued.
 */
export interface CredentialStore {
  lookup(keyId: string): Promise<CredentialRecord | undefined>;
}

/**
 * The seven request shapes Ghost 6.55 sends, and the only ones the gateway
 * forwards. `AbortMultipartUpload` is one of the four multipart calls and is
 * an HTTP `DELETE` that removes only an unfinished upload; a `DELETE` of an
 * object is not on this list.
 */
export const ALLOWED_OPERATIONS = [
  'PutObject',
  'CreateMultipartUpload',
  'UploadPart',
  'CompleteMultipartUpload',
  'AbortMultipartUpload',
  'HeadObject',
  'GetObject',
] as const;

export type AllowedOperation = (typeof ALLOWED_OPERATIONS)[number];

/**
 * Gives the signature check a tenant's SigV4 secret for a key id. Resolves
 * to `undefined` for a key id that was never issued or is not active, so
 * a disabled credential fails at the signature as well as at the store.
 * The secret is derived on each call and never cached or stored.
 */
export interface SigningSecretSource {
  signingSecret(keyId: string): Promise<string | undefined>;
}
