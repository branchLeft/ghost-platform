'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

const { quarantineBytes } = require('./quarantine');
const { buildRefusalError } = require('./refusal-error');
const { HOLD_OR_FLAG_NOT_IMPLEMENTED } = require('./policy');
const { HoldRegistry, evaluate } = require('./hold');

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
      this.wrappedConfig = wrappedConfig || {};
      // Only the checks that may refuse ever run here: an advisory check
      // ships with blocking=false and is filtered out before it is ever
      // invoked by this adapter.
      this.checks = Array.isArray(checks) ? checks.filter((check) => check.blocking) : [];
      this.policy = config.policy;

      // The hold mechanism differs by storage backend. A bucket
      // config (cdnUrl/endpoint/bucket -- the S3Storage shape) means reads
      // bypass this adapter, so "unserved" can only mean "not yet written
      // to the bucket at all". Anything else is local disk, where this
      // adapter itself is on every read path, so a held object can be
      // written for real and withheld by exists()/read()/serve() instead.
      this.holdMode = this.wrappedConfig.bucket ? 'object' : 'local';
      this.hold = new HoldRegistry({
        checks: this.checks,
        policy: this.policy,
        quarantinePath: this.quarantinePath,
        retryIntervalMs: config.holdRetryMs,
      });
    }

    // The wrapped adapter must still implement saveRaw: Ghost's on-demand
    // resize middleware feature-detects it with a plain `typeof` check and
    // silently disables responsive images for every tenant if it is missing.
    async saveRaw(buffer, targetPath) {
      return this.#scanAndProceed(buffer, {
        proceed: () => this.wrapped.saveRaw(buffer, targetPath),
        onHold: (digest) => this.#holdSaveRaw(digest, buffer, targetPath),
      });
    }

    async save(file, targetDir) {
      const buffer = await fs.readFile(file.path);
      return this.#scanAndProceed(buffer, {
        proceed: () => this.wrapped.save(file, targetDir),
        onHold: (digest) => this.#holdSave(digest, buffer, file, targetDir),
      });
    }

    // Everything this decorator does not intercept is delegated, unchanged,
    // to the wrapped adapter for everything EXCEPT a currently-held digest:
    // exists(), read() and serve() must answer as if it were never written,
    // which is the property that stops handleImageSizes generating a
    // responsive derivative from bytes that have no verdict.
    exists(fileNameOrPath, targetDir) {
      if (targetDir === undefined && this.#isHeld(fileNameOrPath)) {
        return Promise.resolve(false);
      }
      return this.wrapped.exists(fileNameOrPath, targetDir);
    }

    async read(options) {
      const key = options && typeof options === 'object' ? options.path : options;
      if (this.#isHeld(key)) {
        // A typed Ghost error, not a plain one, for the same reason
        // refusal-error.js's does: a plain Error is wrapped as a 500 that
        // tells whoever is resizing the platform is broken, where a
        // NotFoundError -- exactly what a genuinely-missing image gets --
        // is wrapped as a clean 404. Measured against a real Ghost 6.55.0:
        // a plain Error here produced an uncaught 500 from
        // handle-image-sizes.js, not the graceful "no derivative" outcome
        // this decorator means to produce.
        throw new GhostErrors.NotFoundError({ message: 'Could not find image.' });
      }
      return this.wrapped.read(options);
    }

    delete(...args) {
      return this.wrapped.delete(...args);
    }

    urlToPath(...args) {
      return this.wrapped.urlToPath(...args);
    }

    serve(...args) {
      const middleware = this.wrapped.serve(...args);
      return (req, res, next) => {
        const candidate = req.originalUrl || req.url;
        if (this.#isHeld(candidate)) {
          return next();
        }
        return middleware(req, res, next);
      };
    }

    #isHeld(key) {
      return this.hold.isHeldUrl(key) || this.hold.isHeldPath(key);
    }

    async #scanAndProceed(buffer, { proceed, onHold }) {
      const { decision, verdict } = await evaluate(this.checks, this.policy, buffer);

      if (decision === 'allow') {
        return proceed();
      }

      if (decision === 'refuse') {
        await quarantineBytes(this.quarantinePath, verdict.evidence, buffer);
        throw buildRefusalError(GhostErrors, verdict);
      }

      if (decision === 'hold') {
        // D34: accept the upload and hold the bytes until a verdict
        // arrives. `verdict.evidence` is the digest checks.js already
        // computed -- reusing it rather than re-hashing.
        return onHold(verdict.evidence);
      }

      // 'flag' is named by the seam (Policy.decide's return type) but has
      // no behaviour here: the advisory/flag route is out of scope for this
      // decorator. Failing loudly here is deliberate -- this decorator
      // never guesses a behaviour for an outcome it was told not to
      // implement.
      throw new Error(HOLD_OR_FLAG_NOT_IMPLEMENTED.replace('%s', decision));
    }

    // Local backend: writes the real bytes through the real wrapped
    // adapter immediately -- getting a real, adapter-correct URL for free
    // -- and relies on exists()/read()/serve() above to withhold it while
    // held. Promoting is then only ever an unmask; refusing after a hold
    // deletes the real copy so nothing is left sitting, masked, in the
    // served tree indefinitely.
    async #holdSave(digest, buffer, file, targetDir) {
      if (this.holdMode === 'local') {
        const url = await this.wrapped.save(file, targetDir);
        await this.#registerHold(digest, buffer, url, {
          onAllow: async () => {},
          onRefuse: async () => this.#deleteReal(url),
        });
        return url;
      }
      const targetPath = this.#computeObjectTargetPath(digest, file, targetDir);
      const url = this.#urlForTargetPath(targetPath);
      await this.#registerHold(digest, buffer, url, {
        pathKey: targetPath,
        onAllow: async (heldBuffer) => {
          await this.wrapped.saveRaw(heldBuffer, targetPath);
        },
        onRefuse: async () => {},
      });
      return url;
    }

    async #holdSaveRaw(digest, buffer, targetPath) {
      if (this.holdMode === 'local') {
        const url = await this.wrapped.saveRaw(buffer, targetPath);
        await this.#registerHold(digest, buffer, url, {
          pathKey: targetPath,
          onAllow: async () => {},
          onRefuse: async () => this.#deleteReal(url),
        });
        return url;
      }
      const url = this.#urlForTargetPath(targetPath);
      await this.#registerHold(digest, buffer, url, {
        pathKey: targetPath,
        onAllow: async (heldBuffer) => {
          await this.wrapped.saveRaw(heldBuffer, targetPath);
        },
        onRefuse: async () => {},
      });
      return url;
    }

    async #registerHold(digest, buffer, url, { pathKey, onAllow, onRefuse }) {
      const derivedPathKey =
        pathKey ??
        (typeof this.wrapped.urlToPath === 'function' ? this.#safeUrlToPath(url) : undefined);
      await this.hold.hold(digest, buffer, {
        urlKey: url,
        pathKey: derivedPathKey,
        onAllow,
        onRefuse,
      });
    }

    #safeUrlToPath(url) {
      try {
        return this.wrapped.urlToPath(url);
      } catch {
        return undefined;
      }
    }

    // Best-effort only: the permanent mask in exists()/read()/serve() is
    // what actually keeps a later-refused, previously-held object
    // unreachable, regardless of whether this cleanup succeeds.
    async #deleteReal(url) {
      const realPath = this.#safeUrlToPath(url);
      if (!realPath) return;
      try {
        await this.wrapped.delete(path.basename(realPath), path.dirname(realPath));
      } catch {
        // Nothing to do -- see comment above.
      }
    }

    // Object-storage hold path only: the wrapped adapter is never asked to
    // write until promotion, so this decorator must pick the eventual
    // target itself. Naming it by digest rather than through the wrapped
    // adapter's own getUniqueFileName avoids a real hazard that would
    // otherwise exist here: two different held uploads sharing an original
    // filename would both compute as free (nothing has been written to
    // wrapped storage for either yet) and collide on promotion.
    #computeObjectTargetPath(digest, file, targetDir) {
      const dir = targetDir || this.#defaultTargetDir();
      const ext = path.extname((file && file.name) || '');
      return path.join(dir, `${digest}${ext}`).split(path.sep).join('/');
    }

    // Ghost's own StorageBase provides getTargetDir on every real adapter;
    // a test double may not, in which case every held object simply lands
    // at the storage root rather than under a date folder -- cosmetic in a
    // test, and never reached in production.
    #defaultTargetDir() {
      if (typeof this.wrapped.getTargetDir === 'function') {
        return this.wrapped.getTargetDir(this.wrapped.storagePath);
      }
      return '';
    }

    // Object-storage hold path only: builds the URL a promoted write to
    // `targetPath` will resolve to, from the same wrappedConfig the real
    // adapter itself was constructed with -- incidental to how any one
    // object-storage adapter is configured, not to the design.
    #urlForTargetPath(targetPath) {
      const normalized = targetPath.split(path.sep).join('/');
      const { cdnUrl, endpoint, bucket } = this.wrappedConfig;
      const base =
        cdnUrl || (endpoint && bucket ? `${endpoint.replace(/\/$/, '')}/${bucket}` : null);
      if (!base) {
        throw new Error(
          'ScanningStorageAdapter: an object-storage hold needs wrappedConfig.cdnUrl, or .endpoint and .bucket, to build a URL'
        );
      }
      return `${base.replace(/\/$/, '')}/${normalized}`;
    }
  };
}

module.exports = { defineScanningStorageAdapter };
