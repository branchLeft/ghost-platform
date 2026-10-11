'use strict';

const { createPdqKnownMaterialCheck } = require('./checks');
const { resolveVerdictSource } = require('./verdict-source');
const { SafetyPolicy } = require('./policy');
const { digestBytes, pdqHashOfImage, decoderLoadError } = require('./pdq');

// Everything the decorator needs from this directory's own modules, built in
// one place so the entry file Ghost loads and the tests exercise the same
// wiring. The verdict client is asked about the perceptual hash of the
// bytes; the content digest names files. See pdq.js for why they differ.
//
// `overrides.verdictClient` is a test seam only: production resolves it from
// config, and an unconfigured deployment gets the client that never vouches.
function buildScanner(config = {}, overrides = {}) {
  const source = resolveVerdictSource(config);
  const verdictClient = overrides.verdictClient || source.verdictClient;
  return {
    checks: [
      createPdqKnownMaterialCheck(verdictClient, {
        computeDigest: digestBytes,
        computeVerdictKey: pdqHashOfImage,
      }),
    ],
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    refuseUploadsReason: source.refuseUploadsReason,
  };
}

// Lines to log once at construction. Without the decoder every upload has
// no hash and is held, which is safe and also total, so it must be loud.
function startupProblems() {
  const err = decoderLoadError();
  if (!err) {
    return [];
  }
  return [
    `ScanningStorageAdapter: PDQ_DECODER_UNAVAILABLE the image decoder could not be loaded (${err.message}): no upload can be hashed, so every upload is held`,
  ];
}

module.exports = { buildScanner, startupProblems };
