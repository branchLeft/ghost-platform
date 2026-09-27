'use strict';

// Ghost loads this file by name from core/server/adapters/storage/ at boot,
// once per configured storage feature (storage:images, storage:media,
// storage:files). It must require nothing Ghost's own image does not
// already resolve from that directory: a module that fails to load stops
// Ghost starting.
const path = require('node:path');
const { StorageBase } = require('ghost-storage-base');
const GhostErrors = require('@tryghost/errors');

const { defineScanningStorageAdapter } = require('./scanning-storage');
const { createPdqKnownMaterialCheck } = require('./checks');
const { FakeVerdictClient } = require('./verdict-client');
const { SafetyPolicy } = require('./policy');
const { digestBytes } = require('./pdq');

// The wrapped adapter is resolved the same way Ghost's own adapter manager
// resolves any adapter: by name, from this same directory. Ghost's built
// image places every built-in storage adapter here alongside this file, so
// naming one by its class name is enough.
function loadWrappedAdapterClass(name) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const moduleExport = require(path.join(__dirname, name));
  return (moduleExport && moduleExport.default) || moduleExport;
}

const Adapter = defineScanningStorageAdapter(StorageBase, { loadWrappedAdapterClass, GhostErrors });

// `refuse` is a plain object of digest -> {classification, matchType}.
// Ghost's env-var config loader parses a JSON-shaped top-level value
// automatically, but a value nested under a feature key (storage__images__…)
// is not guaranteed to be, so a JSON string is accepted too rather than
// trusting that either way.
function parseRefuse(refuse) {
  if (typeof refuse !== 'string') {
    return refuse;
  }
  try {
    return JSON.parse(refuse);
  } catch {
    return {};
  }
}

// The verdict channel is a separate story in a separate repo and does not
// exist yet, so the only implementation available today is the in-process
// fake, seeded from this adapter's own config.
module.exports = class ScanningStorageAdapter extends Adapter {
  constructor(config = {}) {
    const verdictClient = new FakeVerdictClient({ refuse: parseRefuse(config.refuse) });
    super({
      ...config,
      checks: [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })],
      policy: new SafetyPolicy(),
    });
  }
};
