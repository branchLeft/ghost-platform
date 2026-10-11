'use strict';

const { buildScannerUnconfiguredError, buildUncheckableError } = require('./refusal-error');

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    constructor(...args) {
      super(...args);
      // Theme name -> the backup name Ghost asked it be moved to.
      this.deferredMoves = new Map();
    }

    // Ghost moves an existing theme aside to `<name>_<24 hex>` BEFORE it
    // calls save(), and its own restore after a failed save is not awaited
    // and races the removal of that backup: a refused upload could destroy
    // the theme it was replacing. Nothing hands this class the extracted
    // tree before that move, so the move itself waits here until save() has
    // screened the tree, and a refusal never moves anything. Any other
    // rename (Ghost's restore among them) is passed straight through.
    async rename(srcName, destName) {
      const isBackupMove =
        typeof srcName === 'string' &&
        typeof destName === 'string' &&
        new RegExp(`^${escapeRegExp(srcName)}_[0-9a-f]{24}$`).test(destName);
      if (!isBackupMove) {
        return super.rename(srcName, destName);
      }
      this.deferredMoves.set(srcName, destName);
      return undefined;
    }

    // `file.path` is the directory gscan extracted the zip into, the whole
    // tree that is about to be copied into the served themes directory.
    async save(file, targetDir) {
      const name = file && file.name;
      try {
        await scanningAdapter().screenTree(file && file.path);
      } catch (err) {
        this.deferredMoves.delete(name);
        throw err;
      }
      const backupName = this.deferredMoves.get(name);
      this.deferredMoves.delete(name);
      if (backupName !== undefined && (await this.exists(name))) {
        await super.rename(name, backupName);
      }
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
