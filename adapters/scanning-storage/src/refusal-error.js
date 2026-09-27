'use strict';

// A plain Error is wrapped by Ghost as a 500 that tells a paying customer the
// platform is broken. A typed @tryghost/errors error is wrapped as a 415
// that tells them the truth, so the adapter must throw the typed error,
// never a plain one.
//
// The wording then splits by classification: generic for csam -- the
// specific reason is operational intelligence handed to whoever is holding
// the account, which may not be the tenant -- and specific, naming the
// classification, for everything else, because an upload is always made by
// authenticated staff who get an accurate answer rather than being treated
// as adversaries.
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

module.exports = { buildRefusalError, GENERIC_CONTEXT, specificContext };
