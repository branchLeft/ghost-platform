'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
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

const DEFAULT_TREE_MAX_ENTRIES = 5000;
const DEFAULT_TREE_DEADLINE_MS = 30000;

// Every regular file under `rootDir`, in a stable order. A link, device,
// socket or any other entry is not bytes the checks can vouch for (a link
// would be followed by the copy that comes after), so it throws.
// More than `maxEntries` files and directories also throws: the extractor
// bounds bytes, not how many entries a tree has.
async function listTreeFiles(rootDir, maxEntries, buildError) {
  const found = [];
  const pending = [rootDir];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      seen += 1;
      if (seen > maxEntries) {
        throw buildError();
      }
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

// Lower-case base32 (a-z, 2-7): 22 symbols carry 110 bits, so a new upload's
// URL cannot be guessed from a neighbouring public one.
const NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const NAME_RANDOM_CHARS = 22;

function randomNameComponent() {
  const bytes = crypto.randomBytes(NAME_RANDOM_CHARS);
  let out = '';
  for (const byte of bytes) {
    out += NAME_ALPHABET[byte & 31];
  }
  return out;
}

// Ghost saves a processed image first, then its untouched original under the
// STORED basename of the processed one plus `_o` (`<stored>_o<ext>`), and
// finds the original by that name. So the adapter remembers each stored
// basename it hands out, for a short, bounded while, and an upload named
// `<remembered>_o<ext>` keeps exactly that name, once. An `_o` name that
// follows no remembered name is an ordinary upload and gets its own component.
const STORED_NAME_WINDOW_MS = 60000;
const STORED_NAME_MAX_ENTRIES = 1000;
const ORIGINAL_SUFFIX = '_o';
// The 255-byte filename limit, less room for the `_o` Ghost appends and a
// wrapped adapter's own unique-name step.
const MAX_STORED_NAME_BYTES = 240;

// A name that is only an extension (`.jpg`) has none by path.extname's reading.
function splitName(name) {
  const ext = path.extname(name);
  if (ext === '' && /^\.[A-Za-z0-9]+$/.test(name)) {
    return { stem: '', ext: name };
  }
  return { stem: ext ? name.slice(0, -ext.length) : name, ext };
}

function truncateToBytes(text, maxBytes) {
  let out = '';
  let used = 0;
  for (const char of text) {
    used += Buffer.byteLength(char);
    if (used > maxBytes) {
      break;
    }
    out += char;
  }
  return out;
}

// `<stem>-<random>.<ext>`, the stem cut so the whole name fits; a file with
// no usable name is left alone for the wrapped adapter to reject or default
// as it always did.
function withRandomName(file) {
  if (!file || typeof file.name !== 'string' || file.name.length === 0) {
    return file;
  }
  const { stem, ext } = splitName(file.name);
  const room = MAX_STORED_NAME_BYTES - NAME_RANDOM_CHARS - 1 - Buffer.byteLength(ext);
  const kept = truncateToBytes(stem, Math.max(0, room)) || 'upload';
  return { ...file, name: `${kept}-${randomNameComponent()}${ext}` };
}

function pruneStoredNames(names, now) {
  for (const [name, entry] of names) {
    if (entry.expiresAt <= now) {
      names.delete(name);
    }
  }
}

function rememberStoredName(names, storedName, now = Date.now()) {
  if (typeof storedName !== 'string' || storedName.length === 0) {
    return;
  }
  pruneStoredNames(names, now);
  names.delete(storedName);
  if (names.size >= STORED_NAME_MAX_ENTRIES) {
    names.delete(names.keys().next().value);
  }
  names.set(storedName, { expiresAt: now + STORED_NAME_WINDOW_MS });
}

// True, and the entry is spent, when the file is `<remembered>_o<ext>`.
function takeOriginalOf(file, names, now = Date.now()) {
  pruneStoredNames(names, now);
  if (!file || typeof file.name !== 'string') {
    return false;
  }
  const { stem, ext } = splitName(file.name);
  if (!stem.endsWith(ORIGINAL_SUFFIX) || stem.length <= ORIGINAL_SUFFIX.length) {
    return false;
  }
  return names.delete(`${stem.slice(0, -ORIGINAL_SUFFIX.length)}${ext}`);
}

// Ghost's content importer asks getUniqueFileName() for each file's path,
// rewrites every post and image reference to it, and only later calls
// save(). So the name chosen there is reserved for that file (keyed by its
// temp path, directory and name), held until save() takes it or an hour
// passes, and refused outright when the table is full rather than letting a
// reference dangle later.
const RESERVATION_WINDOW_MS = 60 * 60 * 1000;
const RESERVATION_MAX_ENTRIES = 100000;

function reservationKey(file, targetDir) {
  return `${file.path || ''}\n${targetDir || ''}\n${file.name}`;
}

function liveReservation(reservations, key, now = Date.now()) {
  for (const [other, entry] of reservations) {
    if (entry.expiresAt <= now) {
      reservations.delete(other);
    }
  }
  return reservations.get(key)?.name;
}

// The reserved basename, spent, or undefined.
function takeReservation(reservations, key, now = Date.now()) {
  const name = liveReservation(reservations, key, now);
  reservations.delete(key);
  return name;
}

// What the wrapped adapter actually stored: the last segment of the URL it
// returned, falling back to the name it was given.
function storedBasename(url, fallback) {
  if (typeof url !== 'string') {
    return fallback;
  }
  return url.split(/[?#]/)[0].split('/').pop() || fallback;
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
      // A directory tree (a theme) is screened one verdict call per file, each
      // up to the check's own timeout, inside one request. Both bounds are
      // incidental like that timeout: they only decline, never allow.
      this.treeMaxEntries =
        Number(config.treeMaxEntries) > 0
          ? Number(config.treeMaxEntries)
          : DEFAULT_TREE_MAX_ENTRIES;
      this.treeDeadlineMs =
        Number(config.treeDeadlineMs) > 0
          ? Number(config.treeDeadlineMs)
          : DEFAULT_TREE_DEADLINE_MS;
      this.storedNames = new Map();
      this.reservedNames = new Map();

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
      // Ghost names an upload after its own filename, so members-only and
      // draft media would otherwise sit at a guessable URL. Named only once
      // the scan has allowed it, so a refusal leaves no name behind. A name
      // reserved by getUniqueFileName() is used as it was promised.
      const key = reservationKey(file, targetDir);
      // `fixed` is a name already promised; without one the name is fresh.
      const promised = () => {
        const reserved = takeReservation(this.reservedNames, key);
        if (reserved !== undefined) {
          return { fixed: reserved, remember: true };
        }
        if (takeOriginalOf(file, this.storedNames)) {
          return { fixed: file.name, remember: false };
        }
        return { fixed: undefined, remember: true };
      };
      try {
        return await this.#scanAndProceed(buffer, {
          proceed: async () => {
            const { fixed, remember } = promised();
            const name = fixed ?? withRandomName(file).name;
            const url = await this.wrapped.save({ ...file, name }, targetDir);
            if (remember) {
              rememberStoredName(this.storedNames, storedBasename(url, name));
            }
            return url;
          },
          onHold: (digest) => {
            const { fixed, remember } = promised();
            const targetPath = this.#computeHeldTargetPath(digest, file, targetDir, fixed);
            if (remember) {
              rememberStoredName(this.storedNames, path.posix.basename(targetPath));
            }
            return this.#registerHold(digest, buffer, targetPath);
          },
        });
      } catch (error) {
        this.reservedNames.delete(key);
        throw error;
      }
    }

    // Ghost's importer calls this for every file, rewrites its references to
    // the returned path, and later calls save() with the same file and
    // directory. The returned path carries the random component, and save()
    // stores at exactly it.
    async getUniqueFileName(file, targetDir) {
      const unique = (named) =>
        typeof super.getUniqueFileName === 'function'
          ? super.getUniqueFileName(named, targetDir)
          : path.join(targetDir || '', named.name);
      const usable = file && typeof file.name === 'string' && file.name.length > 0;
      // A refused upload will never be saved, so there is nothing to reserve.
      if (!usable || this.refuseUploadsReason) {
        return unique(usable ? withRandomName(file) : file);
      }
      const key = reservationKey(file, targetDir);
      const reserved = liveReservation(this.reservedNames, key);
      if (reserved !== undefined) {
        return unique({ ...file, name: reserved });
      }
      if (this.reservedNames.size >= RESERVATION_MAX_ENTRIES) {
        throw new Error(
          'ScanningStorageAdapter: too many upload names are reserved and not yet saved; retry later'
        );
      }
      const result = await unique(withRandomName(file));
      this.reservedNames.set(key, {
        name: path.basename(result),
        expiresAt: Date.now() + RESERVATION_WINDOW_MS,
      });
      return result;
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
      const files = await listTreeFiles(rootDir, this.treeMaxEntries, () =>
        buildUncheckableError(GhostErrors)
      );
      const deadline = Date.now() + this.treeDeadlineMs;
      for (const filePath of files) {
        // Checked before each file, so a slow channel declines the tree
        // after at most one more verdict timeout rather than running on.
        if (Date.now() > deadline) {
          throw buildVerdictPendingError(GhostErrors);
        }
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
    // collide on promotion. The digest is known to anyone holding the same
    // bytes, so the random component is what keeps the key unguessable.
    #computeHeldTargetPath(digest, file, targetDir, fixedName) {
      const dir = targetDir || this.#defaultTargetDir();
      const ext = path.extname((file && file.name) || '');
      // A name already promised (an original's, or one an importer reserved)
      // is kept, so the lookup or reference that was written finds it.
      const name = fixedName ?? `${digest}-${randomNameComponent()}${ext}`;
      return path.join(dir, name).split(path.sep).join('/');
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
