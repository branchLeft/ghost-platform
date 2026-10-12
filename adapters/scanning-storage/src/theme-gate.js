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
      // Backup names whose theme could not be put back, kept on disk.
      this.retainedBackups = new Set();
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
      let movedAside = false;
      if (backupName !== undefined && (await this.exists(name))) {
        await super.rename(name, backupName);
        movedAside = true;
      }
      try {
        return await super.save(file, targetDir);
      } catch (err) {
        if (movedAside) {
          await this.putBack(name, backupName);
        }
        throw err;
      }
    }

    // Ghost's restore after a failed save only renames when the name is
    // absent, and a copy that failed part way leaves it present, so it would
    // not run at all; when it does run it is not awaited before the backup is
    // deleted. The theme is therefore put back here, awaited, before the
    // failure leaves save(). If it cannot be, the backup stays on disk: the
    // delete Ghost makes next is declined and shows in its log.
    async putBack(name, backupName) {
      try {
        await super.delete(name);
        await super.rename(backupName, name);
      } catch {
        this.retainedBackups.add(backupName);
      }
    }

    async delete(fileName, ...rest) {
      if (this.retainedBackups.delete(fileName)) {
        throw new Error(`the theme could not be put back; its backup ${fileName} was kept`);
      }
      return super.delete(fileName, ...rest);
    }

    // No Ghost code writes a theme from a buffer. A caller that started to
    // would carry no tree to check, so it is declined rather than inherited.
    async saveRaw() {
      throw buildUncheckableError(GhostErrors);
    }
  };
}

module.exports = { defineGatedThemeStorage };
