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

module.exports = {
  buildRefusalError,
  buildScannerUnconfiguredError,
  GENERIC_CONTEXT,
  UNCONFIGURED_MESSAGE,
  UNCONFIGURED_CONTEXT,
  specificContext,
};
