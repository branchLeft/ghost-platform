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
};

/** The one refusal for a code. Messages never echo the bucket, key or folder. */
export function refusal(code: RefusalCode): Refusal {
  return REFUSALS[code];
}

/** S3-style error body, so Ghost's SDK reports a clear error instead of a parse failure. */
export function refusalBody(r: Refusal): string {
  const s3Code =
    r.status >= 500 ? 'ServiceUnavailable' : r.status === 400 ? 'InvalidURI' : 'AccessDenied';
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${s3Code}</Code><Message>${r.message}</Message></Error>`;
}
