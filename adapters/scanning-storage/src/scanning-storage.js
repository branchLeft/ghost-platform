'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

const { readRefusal, sealRefusal } = require('./quarantine');
const {
  buildRefusalError,
  buildScannerUnconfiguredError,
  buildVerdictPendingError,
  buildUncheckableError,
} = require('./refusal-error');
const { HOLD_OR_FLAG_NOT_IMPLEMENTED } = require('./policy');
const { HoldRegistry, evaluate } = require('./hold');

// Every regular file under `rootDir`, in a stable order. A link, device,
// socket or any other entry is not bytes the checks can vouch for (a link
// would be followed by the copy that comes after), so it throws.
async function listTreeFiles(rootDir, buildError) {
  const found = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const dir = pending.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        found.push(full);
      } else {
        throw buildError();
      }
    }
  }
  return found;
}

// Builds the decorator over an injected StorageBase, composing with the
// wrapped adapter rather than subclassing one: README traps 3 and 4 say why.
function defineScanningStorageAdapter(StorageBase, deps) {
  const { loadWrappedAdapterClass, GhostErrors } = deps;

  if (typeof loadWrappedAdapterClass !== 'function') {
    throw new Error('defineScanningStorageAdapter requires loadWrappedAdapterClass(name)');
  }
  if (
    !GhostErrors ||
    typeof GhostErrors.UnsupportedMediaTypeError !== 'function' ||
    typeof GhostErrors.MaintenanceError !== 'function'
  ) {
    throw new Error(
      'defineScanningStorageAdapter requires GhostErrors.UnsupportedMediaTypeError and GhostErrors.MaintenanceError'
    );
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
      // Set by the entry file when no verdict source exists. While it is
      // set every save() and saveRaw() is refused before anything is read,
      // hashed, sealed or written: nobody can vouch for the bytes, and a
      // refusal here must not be remembered as a verdict on them.
      this.refuseUploadsReason =
        typeof config.refuseUploadsReason === 'string' && config.refuseUploadsReason.length > 0
          ? config.refuseUploadsReason
          : null;
      this.logger = config.holdLogger || console;
      this.wrapsName = wraps;
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

      // Same-name replacement window: see delete() and save().
      this.overwriteWindowMs =
        Number(config.overwriteWindowMs) > 0 ? Number(config.overwriteWindowMs) : 60000;
      this.pendingOverwrites = new Map();

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

      if (this.refuseUploadsReason) {
        this.logger.error(
          `ScanningStorageAdapter: ${this.refuseUploadsReason} wraps=${wraps}: no verdict source is configured, so every upload on this feature is refused until one is`
        );
      }
    }

    // Closed by default: see the constructor. Reads, exists() and serve()
    // are untouched, so what is already stored keeps being served.
    #refuseIfNoVerdictSource() {
      if (!this.refuseUploadsReason) {
        return;
      }
      this.logger.error(
        `ScanningStorageAdapter: UPLOAD_REFUSED_${this.refuseUploadsReason} wraps=${this.wrapsName}`
      );
      throw buildScannerUnconfiguredError(GhostErrors);
    }

    // The wrapped adapter must still implement saveRaw: Ghost's on-demand
    // resize middleware feature-detects it with a plain `typeof` check and
    // silently disables responsive images for every tenant if it is missing.
    async saveRaw(buffer, targetPath) {
      this.#refuseIfNoVerdictSource();
      return this.#scanAndProceed(buffer, {
        proceed: () => this.wrapped.saveRaw(buffer, targetPath),
        onHold: (digest) => this.#registerHold(digest, buffer, targetPath),
      });
    }

    async save(file, targetDir) {
      this.#refuseIfNoVerdictSource();
      const buffer = await fs.readFile(file.path);
      if (this.#takePendingOverwrite(file && file.name, targetDir)) {
        // The caller removed this name a moment ago and is replacing it.
        // wrapped.save() would see a free name only on a backend that
        // really deleted, and would otherwise pick a new one, so the bytes
        // go to the same key as an ordinary, scanned, overwriting write.
        const targetPath = this.#overwriteKey(file.name, targetDir);
        return this.#scanAndProceed(buffer, {
          proceed: () => this.wrapped.saveRaw(buffer, targetPath),
          onHold: (digest) => this.#registerHold(digest, buffer, targetPath),
        });
      }
      return this.#scanAndProceed(buffer, {
        proceed: () => this.wrapped.save(file, targetDir),
        onHold: (digest) =>
          this.#registerHold(digest, buffer, this.#computeHeldTargetPath(digest, file, targetDir)),
      });
    }

    // For bytes Ghost writes as a directory tree outside save()/saveRaw()
    // (an extracted theme). Every regular file goes through the same
    // refusal-record lookup, checks and policy as an upload, and nothing is
    // written to the wrapped adapter. A tree cannot be held and served later,
    // so anything but a clean verdict for every file declines the tree.
    async screenTree(rootDir) {
      this.#refuseIfNoVerdictSource();
      if (typeof rootDir !== 'string' || rootDir.length === 0) {
        throw buildUncheckableError(GhostErrors);
      }
      const files = await listTreeFiles(rootDir, () => buildUncheckableError(GhostErrors));
      for (const filePath of files) {
        const buffer = await fs.readFile(filePath);
        await this.#scanAndProceed(buffer, {
          proceed: async () => {},
          onHold: async () => {
            throw buildVerdictPendingError(GhostErrors);
          },
        });
      }
    }

    // Never reaches the wrapped adapter: the storage gateway refuses every
    // delete, and the one place Ghost deletes is replacing a same-name
    // thumbnail (delete, then save). The request is remembered for a short
    // window instead, and the next save() of that name overwrites the key.
    // The previous version of the object stays recoverable through bucket versioning.
    async delete(fileName, targetDir) {
      const now = Date.now();
      for (const [key, expiresAt] of this.pendingOverwrites) {
        if (expiresAt <= now) {
          this.pendingOverwrites.delete(key);
        }
      }
      const key = this.#overwriteKey(fileName, targetDir);
      this.pendingOverwrites.set(key, now + this.overwriteWindowMs);
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

    urlToPath(...args) {
      return this.wrapped.urlToPath(...args);
    }

    serve(...args) {
      return this.wrapped.serve(...args);
    }

    #overwriteKey(fileName, targetDir) {
      const name = String(fileName);
      const joined = targetDir ? path.posix.join(String(targetDir), name) : name;
      return joined.replace(/^\/+/, '');
    }

    // One-shot: consumed by the save it announced, or dropped once stale.
    #takePendingOverwrite(fileName, targetDir) {
      if (typeof fileName !== 'string' || fileName.length === 0) {
        return false;
      }
      const key = this.#overwriteKey(fileName, targetDir);
      const expiresAt = this.pendingOverwrites.get(key);
      if (expiresAt === undefined) {
        return false;
      }
      this.pendingOverwrites.delete(key);
      return expiresAt > Date.now();
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
        // Another feature may have sealed this digest while the verdict was
        // in flight.
        const sealedSince = readRefusal(this.quarantinePath, digest);
        if (sealedSince) {
          await sealRefusal(this.quarantinePath, digest, buffer, sealedSince, this.computeDigest);
          throw buildRefusalError(GhostErrors, sealedSince);
        }
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
