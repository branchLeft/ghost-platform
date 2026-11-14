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
const { PRODUCTION, resolveVerdictSource } = require('./verdict-source');
const { createSocketVerdictTransport } = require('./socket-verdict-transport');
const { resolveTierPolicy } = require('./tier-policy');
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

// Ghost's own image resizer, which Ghost core already depends on and so
// resolves from this directory as it does Ghost's errors module. The decorator
// uses it to write the size variants Ghost core asks the object store for
// directly (scanning-storage.js, "Icon variants"). Loaded when the adapter is
// built, not when this file is: a missing module must not stop Ghost starting.
// null makes the decorator log ICON_VARIANTS_UNAVAILABLE on the object-storage
// images tier.
function loadImageTransform() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require('@tryghost/image-transform');
  } catch (error) {
    return null;
  }
}

const Adapter = defineScanningStorageAdapter(StorageBase, { loadWrappedAdapterClass, GhostErrors });

// The transport for `verdictSource=production`: the local unix socket the
// host end listens on, named by `verdictSocketPath`. Only that setting names
// a socket. With no path, or one the transport refuses (not an absolute
// path), there is no transport, so `production` has no source and refuses
// every upload: a missing setting is never turned into a guessed path.
function socketTransportFor(config) {
  if (config.verdictSource !== PRODUCTION) return undefined;
  try {
    return createSocketVerdictTransport({ socketPath: config.verdictSocketPath });
  } catch {
    return undefined;
  }
}

// A feature has a verdict source only when its config names one outright:
// `production` with a socket path (the host end of the verdict channel), or
// `in-process-fake` (demo, dev and test paths). Otherwise it has none, and
// the decorator refuses new uploads rather than vouching for bytes nobody
// scanned. verdict-source.md says why the default is closed and what an
// operator sees.
module.exports = class ScanningStorageAdapter extends Adapter {
  constructor(config = {}) {
    const { verdictClient, refuseUploadsReason } = resolveVerdictSource(config, {
      transport: socketTransportFor(config),
      logger: config.holdLogger || console,
    });
    // One registry for the process, exported only when both keys are set
    // (metrics.md#configuration); nothing is written otherwise.
    const metrics = getProcessMetrics();
    configureProcessExport(config, config.holdLogger || console, metrics);
    super({
      ...config,
      metrics,
      checks: [
        createPdqKnownMaterialCheck(verdictClient, {
          computeDigest: digestBytes,
          metrics,
          logger: config.holdLogger || console,
        }),
      ],
      policy: new SafetyPolicy(),
      imageTransform: loadImageTransform(),
      computeDigest: digestBytes,
      refuseUploadsReason,
      allowVideoAudio: resolveTierPolicy(config).allowVideoAudio,
      holdRetryMs: config.holdRetryMs ? Number(config.holdRetryMs) : undefined,
      holdMaxRetryMs: config.holdMaxRetryMs ? Number(config.holdMaxRetryMs) : undefined,
      holdMaxFailures: config.holdMaxFailures ? Number(config.holdMaxFailures) : undefined,
    });
  }
};
