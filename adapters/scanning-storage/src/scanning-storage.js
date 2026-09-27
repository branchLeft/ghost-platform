'use strict';

const fs = require('node:fs/promises');

const { quarantineBytes } = require('./quarantine');
const { buildRefusalError } = require('./refusal-error');
const { HOLD_OR_FLAG_NOT_IMPLEMENTED } = require('./policy');

// Builds the decorator class over Ghost's storage base class. Kept apart
// from the entry file so the logic is testable without Ghost's module tree
// or a real StorageBase (mirrors adapters/sso's break-glass.js split).
//
// `StorageBase` is Ghost's own dependency (ghost-storage-base, already
// installed in the built image because Ghost core itself depends on it) --
// injected rather than required here, so a test double can stand in without
// installing Ghost's own package tree.
//
// This class composes with the wrapped adapter instance rather than
// extending it. A decorator that instead subclassed one concrete adapter
// (say, the local one) would leave every other adapter -- S3Storage included
// -- entirely unwrapped and unscanned, silently, because the class would
// simply not be in that adapter's path.
function defineScanningStorageAdapter(StorageBase, deps) {
  const { loadWrappedAdapterClass, GhostErrors } = deps;

  if (typeof loadWrappedAdapterClass !== 'function') {
    throw new Error('defineScanningStorageAdapter requires loadWrappedAdapterClass(name)');
  }
  if (!GhostErrors || typeof GhostErrors.UnsupportedMediaTypeError !== 'function') {
    throw new Error('defineScanningStorageAdapter requires GhostErrors.UnsupportedMediaTypeError');
  }

  return class ScanningStorageAdapter extends StorageBase {
    // Called by Ghost's adapter manager at boot, before any instance exists,
    // so a misconfigured adapter fails closed at startup rather than on the
    // first upload. Only checks what Ghost's own declarative config can
    // supply -- `policy` and `checks` are wiring the entry file injects at
    // construction time, never present in raw config, so the constructor
    // (not this static check) is where they are verified.
    static validate(config = {}) {
      const { wraps, quarantinePath } = config;
      if (typeof wraps !== 'string' || wraps.length === 0) {
        throw new Error('ScanningStorageAdapter requires config.wraps naming the adapter to wrap');
      }
      if (typeof quarantinePath !== 'string' || quarantinePath.length === 0) {
        throw new Error('ScanningStorageAdapter requires config.quarantinePath');
      }
    }

    constructor(config = {}) {
      super();
      ScanningStorageAdapter.validate(config);
      const { wraps, wrappedConfig, checks, policy } = config;
      if (!policy || typeof policy.decide !== 'function') {
        throw new Error(
          'ScanningStorageAdapter requires config.policy implementing decide(verdict)'
        );
      }

      const WrappedClass = loadWrappedAdapterClass(wraps);
      this.wrapped = new WrappedClass(wrappedConfig);
      this.storagePath = this.wrapped.storagePath;
      this.quarantinePath = config.quarantinePath;
      // Only the checks that may refuse ever run here: an advisory check
      // ships with blocking=false and is filtered out before it is ever
      // invoked by this adapter.
      this.checks = Array.isArray(checks) ? checks.filter((check) => check.blocking) : [];
      this.policy = config.policy;
    }

    // The wrapped adapter must still implement saveRaw: Ghost's on-demand
    // resize middleware feature-detects it with a plain `typeof` check and
    // silently disables responsive images for every tenant if it is missing.
    async saveRaw(buffer, targetPath) {
      return this.#scanAndProceed(buffer, () => this.wrapped.saveRaw(buffer, targetPath));
    }

    async save(file, targetDir) {
      const buffer = await fs.readFile(file.path);
      return this.#scanAndProceed(buffer, () => this.wrapped.save(file, targetDir));
    }

    // Everything this decorator does not intercept is delegated, unchanged,
    // to the wrapped adapter -- exists, read, delete, urlToPath and serve are
    // never touched by a check.
    exists(...args) {
      return this.wrapped.exists(...args);
    }

    read(...args) {
      return this.wrapped.read(...args);
    }

    delete(...args) {
      return this.wrapped.delete(...args);
    }

    urlToPath(...args) {
      return this.wrapped.urlToPath(...args);
    }

    serve(...args) {
      return this.wrapped.serve(...args);
    }

    async #scanAndProceed(buffer, proceed) {
      for (const check of this.checks) {
        const verdict = await check.run({ buffer });
        const decision = this.policy.decide(verdict, { kind: check.kind });

        if (decision === 'allow') {
          continue;
        }

        if (decision === 'refuse') {
          await quarantineBytes(this.quarantinePath, verdict.evidence, buffer);
          throw buildRefusalError(GhostErrors, verdict);
        }

        // hold and flag are named by the seam (Policy.decide's return type)
        // but have no behaviour here: the promote-on-clean-verdict mechanism
        // a real hold needs, and the advisory/flag route, are both out of
        // scope for this decorator. Failing loudly here is deliberate --
        // this decorator never guesses a behaviour for an outcome it was
        // told not to implement.
        throw new Error(HOLD_OR_FLAG_NOT_IMPLEMENTED.replace('%s', decision));
      }

      return proceed();
    }
  };
}

module.exports = { defineScanningStorageAdapter };
