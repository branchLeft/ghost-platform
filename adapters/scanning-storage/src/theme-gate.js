'use strict';

const { buildScannerUnconfiguredError, buildUncheckableError } = require('./refusal-error');

// Ghost writes an uploaded theme with its own ThemeStorage, constructed
// directly and never resolved through the adapter manager, so the scanning
// decorator cannot be configured onto it. The core overlay in
// ghost-core-overlay/ puts this subclass over it instead.
//
// The gate asks the `storage:images` decorator Ghost already built, so a
// theme meets the same verdict source, quarantine and policy an editor
// upload does. That decorator missing, or not the scanning one, declines
// the write: nothing that cannot be checked is accepted.
function defineGatedThemeStorage(UpstreamThemeStorage, deps) {
  const { adapterManager, GhostErrors } = deps;

  if (typeof UpstreamThemeStorage !== 'function') {
    throw new Error('defineGatedThemeStorage requires the upstream ThemeStorage class');
  }
  if (!adapterManager || typeof adapterManager.getAdapter !== 'function') {
    throw new Error('defineGatedThemeStorage requires adapterManager.getAdapter');
  }
  if (
    !GhostErrors ||
    typeof GhostErrors.UnsupportedMediaTypeError !== 'function' ||
    typeof GhostErrors.MaintenanceError !== 'function'
  ) {
    throw new Error(
      'defineGatedThemeStorage requires GhostErrors.UnsupportedMediaTypeError and GhostErrors.MaintenanceError'
    );
  }

  function scanningAdapter() {
    let adapter = null;
    try {
      adapter = adapterManager.getAdapter('storage:images');
    } catch {
      adapter = null;
    }
    if (!adapter || typeof adapter.screenTree !== 'function') {
      throw buildScannerUnconfiguredError(GhostErrors);
    }
    return adapter;
  }

  return class GatedThemeStorage extends UpstreamThemeStorage {
    // `file.path` is the directory gscan extracted the zip into, the whole
    // tree that is about to be copied into the served themes directory.
    async save(file, targetDir) {
      await scanningAdapter().screenTree(file && file.path);
      return super.save(file, targetDir);
    }

    // No Ghost code writes a theme from a buffer. A caller that started to
    // would carry no tree to check, so it is declined rather than inherited.
    async saveRaw() {
      throw buildUncheckableError(GhostErrors);
    }
  };
}

module.exports = { defineGatedThemeStorage };
