'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

const { readRefusal, sealRefusal } = require('./quarantine');
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
      const { wraps, wrappedConfig, checks, policy, computeDigest } = config;
      if (!policy || typeof policy.decide !== 'function') {
        throw new Error(
          'ScanningStorageAdapter requires config.policy implementing decide(verdict)'
        );
      }
      // The same function the blocking checks name bytes with: quarantine
      // files are filed under it, and a digest's refusal record is looked up
      // by it before any verdict is asked for.
      if (typeof computeDigest !== 'function') {
        throw new Error('ScanningStorageAdapter requires config.computeDigest(buffer)');
      }
      this.computeDigest = computeDigest;

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

      this.hold = new HoldRegistry({
        checks: this.checks,
        policy: this.policy,
        quarantinePath: this.quarantinePath,
        // Ghost never tells an adapter which feature it serves, and every
        // feature's decorator shares one quarantinePath. The wrapped
        // adapter's storagePath is what differs between features, on both
        // backends (a directory for the local adapters, the
        // staticFileURLPrefix for S3Storage), and it is where a promotion
        // lands -- so it is what a resumed hold must match.
        owner: `${wraps}:${this.storagePath ?? ''}`,
        computeDigest,
        retryIntervalMs: config.holdRetryMs,
        maxRetryIntervalMs: config.holdMaxRetryMs,
        maxConsecutiveFailures: config.holdMaxFailures,
        logger: config.holdLogger,
      });
      // Restart-safety (load-bearing per the design): the quarantine directory is
      // the source of truth for every hold that outlived the previous
      // process -- a deploy (this repo's own CD queues one on every merge
      // to main), a crash, an OOM kill, a health-check restart. Resumed
      // synchronously, before this constructor returns, so no request can
      // be served in the gap.
      this.hold.resumeFromQuarantine((targetPath) => this.#buildHoldCallbacks(targetPath));
    }

    // The wrapped adapter must still implement saveRaw: Ghost's on-demand
    // resize middleware feature-detects it with a plain `typeof` check and
    // silently disables responsive images for every tenant if it is missing.
    async saveRaw(buffer, targetPath) {
      return this.#scanAndProceed(buffer, {
        proceed: () => this.wrapped.saveRaw(buffer, targetPath),
        onHold: (digest) => this.#registerHold(digest, buffer, targetPath),
      });
    }

    async save(file, targetDir) {
      const buffer = await fs.readFile(file.path);
      return this.#scanAndProceed(buffer, {
        proceed: () => this.wrapped.save(file, targetDir),
        onHold: (digest) =>
          this.#registerHold(digest, buffer, this.#computeHeldTargetPath(digest, file, targetDir)),
      });
    }

    // Nothing here is intercepted, on either backend: a currently-held
    // digest is never written to the wrapped adapter in the first place
    // (see #registerHold), so exists()/read()/serve() answering truthfully
    // IS the withholding -- there is no in-memory mask to keep in sync
    // with reality, and nothing for a process restart to lose. The design's
    // own words for the local backend: "held outside the served tree."
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

    async #scanAndProceed(buffer, { proceed, onHold }) {
      // A digest any feature has refused stays refused here too, whatever a
      // verdict would say now: positive verdicts never expire.
      const digest = this.computeDigest(buffer);
      const sealed = readRefusal(this.quarantinePath, digest);
      if (sealed) {
        await sealRefusal(this.quarantinePath, digest, buffer, sealed, this.computeDigest);
        throw buildRefusalError(GhostErrors, sealed);
      }

      const { decision, verdict } = await evaluate(this.checks, this.policy, buffer);

      if (decision === 'allow') {
        return proceed();
      }

      if (decision === 'refuse') {
        await sealRefusal(
          this.quarantinePath,
          verdict.evidence,
          buffer,
          verdict,
          this.computeDigest
        );
        throw buildRefusalError(GhostErrors, verdict);
      }

      if (decision === 'hold') {
        // Accept the upload and hold the bytes until a verdict
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

    // Never writes to the wrapped adapter until a clean verdict promotes
    // it -- identical on both backends now. On object storage that is the
    // only way "unserved" can mean anything (the CDN reads the bucket
    // directly, bypassing this adapter entirely); on local disk it is also
    // what the design specifies, and it has a second benefit the old
    // write-then-mask shape didn't: nothing here depends on in-memory
    // state a restart could lose.
    async #registerHold(digest, buffer, targetPath) {
      const url = this.#urlForTargetPath(targetPath);
      await this.hold.hold(digest, buffer, { targetPath, ...this.#buildHoldCallbacks(targetPath) });
      return url;
    }

    // Shared by a fresh hold and a resumed one (HoldRegistry.resumeFromQuarantine)
    // so promotion behaves identically regardless of which process instance
    // observes the clean verdict. A refusal after a hold needs no cleanup
    // here: nothing was ever written to undo.
    #buildHoldCallbacks(targetPath) {
      return {
        onAllow: async (heldBuffer) => {
          await this.wrapped.saveRaw(heldBuffer, targetPath);
        },
        onRefuse: async () => {},
      };
    }

    // The wrapped adapter is never asked to write until promotion, so this
    // decorator must pick the eventual target itself. Naming it by digest
    // rather than through the wrapped adapter's own getUniqueFileName
    // avoids a real hazard that would otherwise exist here: two different
    // held uploads sharing an original filename would both compute as free
    // (nothing has been written to wrapped storage for either yet) and
    // collide on promotion.
    #computeHeldTargetPath(digest, file, targetDir) {
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

    // Builds the URL a promoted write to `targetPath` will resolve to, from
    // the same wrappedConfig the real adapter itself was constructed with.
    // A bucket config (cdnUrl/endpoint/bucket -- the S3Storage shape) means
    // an absolute, CDN-hosted URL; anything else is a local, site-relative
    // one. Incidental to how any one object-storage adapter is configured,
    // not to the design.
    #urlForTargetPath(targetPath) {
      const normalized = targetPath.split(path.sep).join('/');
      const { cdnUrl, endpoint, bucket } = this.wrappedConfig;
      if (bucket) {
        const base = cdnUrl || (endpoint ? `${endpoint.replace(/\/$/, '')}/${bucket}` : null);
        if (!base) {
          throw new Error(
            'ScanningStorageAdapter: an object-storage hold needs wrappedConfig.cdnUrl, or .endpoint and .bucket, to build a URL'
          );
        }
        return `${base.replace(/\/$/, '')}/${normalized}`;
      }
      const feature =
        typeof this.wrapped.storagePath === 'string'
          ? path.basename(this.wrapped.storagePath)
          : 'images';
      return `/content/${feature}/${normalized}`;
    }
  };
}

module.exports = { defineScanningStorageAdapter };
