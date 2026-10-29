import type { Refusal, RefusalCode } from './contracts.js';

const REFUSALS: Readonly<Record<RefusalCode, Refusal>> = {
  'internal-error': {
    code: 'internal-error',
    message: 'The gateway could not decide this request. Try again.',
    status: 503,
  },
  'signature-refused': {
    code: 'signature-refused',
    message: 'The request signature was not accepted.',
    status: 403,
  },
  'credential-not-active': {
    code: 'credential-not-active',
    message: 'This credential is not active.',
    status: 403,
  },
  'credential-invalid': {
    code: 'credential-invalid',
    message: 'This credential cannot be used.',
    status: 403,
  },
  'operation-not-allowed': {
    code: 'operation-not-allowed',
    message: 'This operation is not allowed.',
    status: 403,
  },
  'target-malformed': {
    code: 'target-malformed',
    message: 'The request target is not valid.',
    status: 400,
  },
  'bucket-not-allowed': {
    code: 'bucket-not-allowed',
    message: 'Access to this bucket is not allowed.',
    status: 403,
  },
  'upload-not-bound': {
    code: 'upload-not-bound',
    message: 'This upload is not open for this object name.',
    status: 403,
  },
  'key-outside-folder': {
    code: 'key-outside-folder',
    message: 'Access to this object name is not allowed.',
    status: 403,
  },
  'upstream-timeout': {
    code: 'upstream-timeout',
    message: 'The storage service did not answer in time. Try again.',
    status: 504,
  },
  'upstream-unavailable': {
    code: 'upstream-unavailable',
    message: 'The storage service is not available. Try again.',
    status: 503,
  },
  'upstream-throttled': {
    code: 'upstream-throttled',
    message: 'The storage service is busy. Try again.',
    status: 503,
  },
};

/** The one refusal for a code. Messages never echo the bucket, key or folder. */
export function refusal(code: RefusalCode): Refusal {
  return REFUSALS[code];
}

/** S3-style error body, so Ghost's SDK reports a clear error instead of a parse failure. */
export function refusalBody(r: Refusal): string {
  return s3ErrorBody(s3CodeFor(r), r.message);
}

/** The S3 error code the SDK's retry logic reads: SlowDown and RequestTimeout are both retried. */
function s3CodeFor(r: Refusal): string {
  if (r.code === 'upstream-throttled') return 'SlowDown';
  if (r.code === 'upstream-timeout') return 'RequestTimeout';
  if (r.status >= 500) return 'ServiceUnavailable';
  return r.status === 400 ? 'InvalidURI' : 'AccessDenied';
}

/** A minimal S3 error document. Both arguments must already be safe to show a tenant. */
export function s3ErrorBody(s3Code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${s3Code}</Code><Message>${message}</Message></Error>`;
}
