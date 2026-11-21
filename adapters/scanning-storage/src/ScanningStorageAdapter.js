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
const { IN_PROCESS_FAKE, PRODUCTION, resolveVerdictSource } = require('./verdict-source');
const { createSocketVerdictTransport } = require('./socket-verdict-transport');
const { resolveTierPolicy } = require('./tier-policy');
const { SafetyPolicy } = require('./policy');
const { getProcessMetrics, configureProcessExport } = require('./metrics');
const { digestBytes, digestVerdictKey, pdqHashOfImage, decoderLoadError } = require('./pdq');

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
    const { kind, verdictClient, refuseUploadsReason } = resolveVerdictSource(config, {
      transport: socketTransportFor(config),
      logger: config.holdLogger || console,
    });
    // What the verdict source is asked about. The hash source takes a PDQ hash
    // and nothing else, so `production` asks about that. The in-process fake is
    // a test double with no hash source behind it: its seeds (`refuse`,
    // `unavailable`, `resolvePath`) name bytes by digest, as its documentation
    // says, and so it is asked about the digest, for any bytes (a theme's
    // templates, a file that is not a picture) as before.
    const computeVerdictKey = kind === IN_PROCESS_FAKE ? digestVerdictKey : pdqHashOfImage;
    // Without the image decoder no upload has a hash, so every one is held:
    // safe and also total, so it is said once, loudly, at construction.
    const decoderError = kind === PRODUCTION ? decoderLoadError() : null;
    if (decoderError) {
      (config.holdLogger || console).error(
        `ScanningStorageAdapter: PDQ_DECODER_UNAVAILABLE the image decoder could not be loaded (${decoderError.message}): no upload can be hashed, so every upload is held`
      );
    }
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
          computeVerdictKey,
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
