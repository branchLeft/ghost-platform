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
const { resolveVerdictSource } = require('./verdict-source');
const { SafetyPolicy } = require('./policy');
const { getProcessMetrics, configureProcessExport } = require('./metrics');
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

// The verdict channel is a separate story in a separate repo and does not
// exist yet. Until it does, a feature has a verdict source only when its
// config says `verdictSource=in-process-fake` outright (demo, dev and test
// paths); otherwise it has none, and the decorator refuses new uploads
// rather than vouching for bytes nobody scanned. verdict-source.md says why
// the default is closed and what an operator sees.
module.exports = class ScanningStorageAdapter extends Adapter {
  constructor(config = {}) {
    const { verdictClient, refuseUploadsReason } = resolveVerdictSource(config);
    // One registry for the process, exported only when both keys are set
    // (metrics.md#configuration); nothing is written otherwise.
    const metrics = getProcessMetrics();
    configureProcessExport(config, config.holdLogger || console, metrics);
    super({
      ...config,
      metrics,
      checks: [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes, metrics })],
      policy: new SafetyPolicy(),
      computeDigest: digestBytes,
      refuseUploadsReason,
      holdRetryMs: config.holdRetryMs ? Number(config.holdRetryMs) : undefined,
      holdMaxRetryMs: config.holdMaxRetryMs ? Number(config.holdMaxRetryMs) : undefined,
      holdMaxFailures: config.holdMaxFailures ? Number(config.holdMaxFailures) : undefined,
    });
  }
};
