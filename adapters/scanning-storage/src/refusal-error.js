'use strict';

// Ghost wraps a typed @tryghost/errors error as a 415 that tells the
// customer the truth; a plain Error becomes an opaque 500. See
// refusal-error.md#refusal-wording for why the wording then splits by
// classification.
const GENERIC_CONTEXT =
  'This image could not be accepted. It did not pass the platform safety check.';

function specificContext(classification) {
  return `This image could not be accepted. It was flagged by the platform safety check as ${classification}.`;
}

// `GhostErrors` is `@tryghost/errors`, injected rather than required here so
// this module stays testable without it: Ghost's own image already carries
// it (it is Ghost core's own dependency), and the entry file wires the real
// module in only when this class is loaded inside Ghost.
function buildRefusalError(GhostErrors, verdict) {
  const context =
    verdict.classification === 'csam' ? GENERIC_CONTEXT : specificContext(verdict.classification);
  return new GhostErrors.UnsupportedMediaTypeError({
    message: 'Unsupported media error, cannot upload image.',
    context,
  });
}

// Not a refusal of the bytes: nothing was looked at. The decorator has no
// verdict source, so it cannot vouch for any upload and declines all of
// them. A 503 says "the service cannot do this right now", which is the
// truth, and it names no classification because none was reached.
const UNCONFIGURED_MESSAGE =
  'Uploads are unavailable: the platform safety check is not configured.';
const UNCONFIGURED_CONTEXT =
  'This site cannot accept uploads until its safety check is set up. Contact support.';

function buildScannerUnconfiguredError(GhostErrors) {
  return new GhostErrors.MaintenanceError({
    message: UNCONFIGURED_MESSAGE,
    context: UNCONFIGURED_CONTEXT,
  });
}

// A tree of files (a theme) cannot be accepted-and-held the way one upload
// can: its files are served from where they land. So a verdict that has not
// arrived yet declines the whole tree, and nothing is kept for it.
const VERDICT_PENDING_MESSAGE =
  'Uploads are unavailable: the platform safety check has not answered yet.';
const VERDICT_PENDING_CONTEXT =
  'This upload could not be checked right now and was not accepted. Try again later.';

function buildVerdictPendingError(GhostErrors) {
  return new GhostErrors.MaintenanceError({
    message: VERDICT_PENDING_MESSAGE,
    context: VERDICT_PENDING_CONTEXT,
  });
}

// An entry the checks cannot read as bytes (a link, a device, a socket), or
// a write that carries no file tree to walk. Declined: unchecked is refused.
const UNCHECKABLE_MESSAGE = 'Unsupported media error, cannot accept this upload.';
const UNCHECKABLE_CONTEXT =
  'This upload contains content that could not be checked by the platform safety check.';

function buildUncheckableError(GhostErrors) {
  return new GhostErrors.UnsupportedMediaTypeError({
    message: UNCHECKABLE_MESSAGE,
    context: UNCHECKABLE_CONTEXT,
  });
}

module.exports = {
  buildRefusalError,
  buildScannerUnconfiguredError,
  buildVerdictPendingError,
  buildUncheckableError,
  GENERIC_CONTEXT,
  UNCONFIGURED_MESSAGE,
  UNCONFIGURED_CONTEXT,
  VERDICT_PENDING_MESSAGE,
  VERDICT_PENDING_CONTEXT,
  UNCHECKABLE_MESSAGE,
  UNCHECKABLE_CONTEXT,
  specificContext,
};
