'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');

const {
  readRefusal,
  sealRefusal,
  recordCopy,
  familyKeyOf,
  familiesToFreeze,
  markFamilyFrozen,
  writeLedger,
  unfreezeFamily,
  liftFreeze,
  frozenOf,
} = require('./quarantine');
const {
  AUDIENCE,
  buildRefusalError,
  buildScannerUnconfiguredError,
  buildVerdictPendingError,
  buildUncheckableError,
  buildVideoAudioRefusedError,
  buildNamesFullError,
  buildNameLapsedError,
} = require('./refusal-error');
const { detectVideoAudioFamily } = require('./media-kind');
const { stampImageContentType } = require('./content-type');
const { HOLD_OR_FLAG_NOT_IMPLEMENTED } = require('./policy');
const {
  HoldRegistry,
  evaluate,
  withWriteTimeout,
  isWriteTimeoutError,
  resolveWriteTimeoutMs,
  REQUEST_WRITE_TIMEOUT_LOG_PREFIX,
} = require('./hold');

// Fixed prefixes, so a log search or alert has one string to match.
const MATCH_LOG_PREFIX = 'ScanningStorageAdapter: MATCH';
const FREEZE_FAILED_LOG_PREFIX = 'ScanningStorageAdapter: FREEZE_FAILED';
const FREEZE_INCOMPLETE_LOG_PREFIX = 'ScanningStorageAdapter: FREEZE_INCOMPLETE';
const LIFT_INCOMPLETE_LOG_PREFIX = 'ScanningStorageAdapter: FREEZE_LIFT_INCOMPLETE';
const COPY_LEDGER_FAILED_LOG_PREFIX = 'ScanningStorageAdapter: COPY_LEDGER_FAILED';

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

// `<stem>-<component>.<ext>`, the stem cut so the whole name fits. An original
// (`<stem>_o.<ext>`) is named from the same stem and component with `_o` after
// them, which is the name Ghost looks for beside the processed image.
function nameWithComponent(file, component, isOriginal) {
  const { stem, ext } = splitName(file.name);
  const base = isOriginal ? stem.slice(0, -ORIGINAL_SUFFIX.length) : stem;
  const room = MAX_STORED_NAME_BYTES - NAME_RANDOM_CHARS - 1 - Buffer.byteLength(ext);
  const kept = truncateToBytes(base, Math.max(0, room)) || 'upload';
  return `${kept}-${component}${isOriginal ? ORIGINAL_SUFFIX : ''}${ext}`;
}

// A file with no usable name is left alone for the wrapped adapter to reject
// or default as it always did.
function withRandomName(file) {
  if (!file || typeof file.name !== 'string' || file.name.length === 0) {
    return file;
  }
  return { ...file, name: nameWithComponent(file, randomNameComponent(), false) };
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

// Keys whose promise ran out before its save. A save of one is refused, not
// renamed, and stays refused until getUniqueFileName() promises that file a
// fresh name: Ghost's importer has already written the promised path into the
// references. A lapse is never evicted, because a forgotten lapse would let
// that file store under a fresh name and dangle those references silently.
// So the bound is on reservations and lapses together (see
// getUniqueFileName()), which refuses new promises when it is reached.
function rememberLapsed(lapsed, key) {
  lapsed.set(key, true);
}

function liveReservation(reservations, key, now = Date.now(), lapsed = null) {
  for (const [other, entry] of reservations) {
    if (entry.expiresAt <= now) {
      reservations.delete(other);
      if (lapsed) {
        rememberLapsed(lapsed, other);
      }
    }
  }
  return reservations.get(key)?.name;
}

// An imported processed image and its original arrive as two files,
// `photo.png` and `photo_o.png`, and Ghost finds the original of a stored
// `photo-<c>.png` at `photo-<c>_o.png`. Ghost's importer asks for every file's
// name at once, so neither is promised before the other asks. They are paired
// by what the two share: the directory they will be stored in, the temp
// directory the zip was extracted to (one per import, so another import's
// `photo.png` never matches), and the processed image's name. The first of the
// pair to ask picks the component, the second takes it, and the record goes.
// A record the second never claims is dropped after the same window as a
// promise, and the table is bounded, so a full one only leaves files unpaired.
const FAMILY_WINDOW_MS = RESERVATION_WINDOW_MS;

function isOriginalName(name) {
  const { stem } = splitName(name);
  return stem.endsWith(ORIGINAL_SUFFIX) && stem.length > ORIGINAL_SUFFIX.length;
}

function familyKey(file, targetDir) {
  const { stem, ext } = splitName(file.name);
  const processed = isOriginalName(file.name)
    ? `${stem.slice(0, -ORIGINAL_SUFFIX.length)}${ext}`
    : file.name;
  return `${targetDir || ''}\n${path.dirname(file.path)}\n${processed}`;
}

// The component this file should be named with, or null when it has none to
// share: its role in the family was already taken (a file promised afresh) or
// the table is full. `release` hands the role back when the ask fails.
function claimFamily(families, file, targetDir, maxEntries, now = Date.now()) {
  for (const [key, family] of families) {
    if (family.expiresAt > now) {
      break;
    }
    families.delete(key);
  }
  const role = isOriginalName(file.name) ? 'original' : 'processed';
  const key = familyKey(file, targetDir);
  let family = families.get(key);
  if (!family) {
    if (families.size >= maxEntries) {
      return null;
    }
    family = {
      component: randomNameComponent(),
      expiresAt: now + FAMILY_WINDOW_MS,
      taken: { original: false, processed: false },
    };
    families.set(key, family);
  }
  if (family.taken[role]) {
    return null;
  }
  family.taken[role] = true;
  if (family.taken.original && family.taken.processed) {
    families.delete(key);
  }
  return {
    component: family.component,
    isOriginal: role === 'original',
    release: () => {
      family.taken[role] = false;
      if (!families.has(key)) {
        families.set(key, family);
      }
    },
  };
}

// The reserved basename, spent, or undefined.
function takeReservation(reservations, key, now = Date.now(), lapsed = null) {
  const name = liveReservation(reservations, key, now, lapsed);
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

// Icon variants. Ghost core rewrites a stored image's URL to its 256x256
// variant (`/content/images/size/w256h256/...`) for the settings API (Ghost
// admin and the Content API) and for the site's favicon link. On object
// storage the stored URL is absolute, so the rewrite stays on the bucket and
// the browser asks the bucket for the variant directly. Ghost's resize
// middleware, the only thing that writes a variant, never sees the request,
// and the bucket answers 403 for a key that was never written. So the
// decorator writes the variants when it stores an image (size-variants in
// README.md says why this, and not a Ghost patch or a URL change).
const ICON_SIZE_DIR = 'w256h256';
const ICON_SIZE = { width: 256, height: 256 };
// The resize bound Ghost's middleware uses.
const ICON_RESIZE_TIMEOUT_SECONDS = 10;
const ICON_VARIANT_FAILED_LOG_PREFIX = 'ScanningStorageAdapter: ICON_VARIANT_FAILED';
const ICON_VARIANTS_UNAVAILABLE_LOG_PREFIX = 'ScanningStorageAdapter: ICON_VARIANTS_UNAVAILABLE';
// A stored original Ghost keeps beside its processed upload (`name_o.png`).
const ORIGINAL_NAME_PATTERN = /_o\.[^./]+$/;

// The format blog-icon.js asks for when the icon's own type is not served
// as it is: a .jpg as jpeg, anything else that is not png or jpeg as png.
// null: the plain variant is the one it asks for.
function iconFormatFor(ext) {
  if (ext === '.png' || ext === '.jpeg') {
    return null;
  }
  return ext === '.jpg' ? 'jpeg' : 'png';
}

// The variants of one stored image that Ghost core asks the bucket for, as
// [format-or-null, ...]. Mirrors handle-image-sizes.js: a variant is only
// ever made where the middleware would make it, so a type it redirects to
// the original (an .ico, a plain .svg) gets none.
function iconVariantFormats(ext, imageTransform) {
  if (!imageTransform.canTransformFileExtension(ext)) {
    return [];
  }
  const formats = [];
  if (imageTransform.shouldResizeFileExtension(ext)) {
    formats.push(null);
  }
  const format = iconFormatFor(ext);
  if (format !== null && imageTransform.canTransformToFormat(format)) {
    formats.push(format);
  }
  return formats;
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
      // Set by the entry file from the tier. Only the boolean true accepts
      // video and audio, so a decorator built without the option, or with
      // any other value, refuses them. See tier-policy.md.
      this.allowVideoAudio = config.allowVideoAudio === true;
      this.logger = config.holdLogger || console;
      this.metrics =
        config.metrics && typeof config.metrics.recordRefusal === 'function'
          ? config.metrics
          : null;
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
      // content-type.md: without this an S3 object written by saveRaw is
      // stored as application/octet-stream. Silent if it stops working, so
      // the S3 tier says so at boot.
      if (!stampImageContentType(this.wrapped) && wraps === 'S3Storage') {
        this.logger.error(
          `ScanningStorageAdapter: CONTENT_TYPE_STAMP_UNAVAILABLE wraps=${wraps}: the wrapped adapter exposes no S3 client, so objects written by saveRaw are stored without an image content type`
        );
      }
      this.storagePath = this.wrapped.storagePath;
      this.imageTransform = config.imageTransform || null;
      // Ghost's content importer reads this to name imported files, so it must
      // match the wrapped adapter.
      this.staticFileURLPrefix = this.wrapped.staticFileURLPrefix;
      this.quarantinePath = config.quarantinePath;
      // Names this feature's objects in the quarantine directory every
      // feature shares: the copy ledger and a resumed hold are both keyed by
      // it. The wrapped adapter's storagePath is what differs between features.
      this.owner = `${wraps}:${this.storagePath ?? ''}`;
      this.wrappedConfig = wrappedConfig || {};
      if (this.#isBucketImages() && !this.imageTransform) {
        // Silent otherwise: the upload works and only the next icon save fails.
        this.logger.error(
          `${ICON_VARIANTS_UNAVAILABLE_LOG_PREFIX} wraps=${wraps}: no image transform is available, so the size variants Ghost asks the bucket for (the Publication Icon's) are never written`
        );
      }
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
      this.writeTimeoutMs = resolveWriteTimeoutMs(config.writeTimeoutMs);
      this.storedNames = new Map();
      this.reservedNames = new Map();
      this.lapsedReservations = new Map();
      // A promise being worked out, so a concurrent ask for the same file
      // shares it instead of making a second one.
      this.namesInFlight = new Map();
      // Imported processed images awaiting their original, or the reverse.
      this.nameFamilies = new Map();
      // Bounds reservations and lapses together; only a test sets it.
      this.reservationMaxEntries =
        Number(config.reservationMaxEntries) > 0
          ? Number(config.reservationMaxEntries)
          : RESERVATION_MAX_ENTRIES;

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
        owner: this.owner,
        computeDigest,
        retryIntervalMs: config.holdRetryMs,
        maxRetryIntervalMs: config.holdMaxRetryMs,
        maxConsecutiveFailures: config.holdMaxFailures,
        writeTimeoutMs: config.writeTimeoutMs,
        orphanMinAgeMs: Number(config.holdOrphanMinAgeMs),
        orphanSweepIntervalMs: Number(config.holdOrphanSweepIntervalMs),
        logger: config.holdLogger,
      });
      // Restart-safety (load-bearing per the design): the quarantine directory is
      // the source of truth for every hold that outlived the previous
      // process -- a deploy (this repo's own CD queues one on every merge
      // to main), a crash, an OOM kill, a health-check restart. Resumed
      // synchronously, before this constructor returns, so no request can
      // be served in the gap.
      this.hold.resumeFromQuarantine((targetPath) => this.#buildHoldCallbacks(targetPath));
      if (this.metrics) {
        this.metrics.addHeldSource(() => this.hold.heldSummary());
      }

      if (this.refuseUploadsReason) {
        if (this.metrics) {
          this.metrics.recordUnconfiguredInstance();
        }
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
      if (this.metrics) {
        this.metrics.recordRefusal('unconfigured');
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
      // A copy of an upload that matched is not made, whatever asks for it: a
      // responsive derivative generated now would be a new copy of withheld
      // material.
      this.#refuseIfFrozen(targetPath);
      return this.#scanAndProceed(buffer, {
        hintPath: targetPath,
        proceed: async (scanned) => {
          const url = await this.wrapped.saveRaw(buffer, targetPath);
          if (scanned) this.#recordCopy(targetPath, buffer);
          return url;
        },
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
          hintPath: targetPath,
          proceed: async (scanned) => {
            const url = await this.wrapped.saveRaw(buffer, targetPath);
            if (scanned) this.#recordCopy(targetPath, buffer);
            await this.#writeIconVariants(buffer, targetPath);
            return url;
          },
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
        const reserved = takeReservation(
          this.reservedNames,
          key,
          Date.now(),
          this.lapsedReservations
        );
        if (reserved !== undefined) {
          return { fixed: reserved, remember: true };
        }
        // The promise ran out before this save (during the scan, or before it
        // began). Refused rather than stored under a fresh name: the importer
        // already wrote the promised path into its references, so a fresh name
        // would dangle them silently. Kept, so a retry is refused too, until
        // getUniqueFileName() promises this file a fresh name.
        if (this.lapsedReservations.has(key)) {
          throw buildNameLapsedError(GhostErrors, file.name);
        }
        if (takeOriginalOf(file, this.storedNames)) {
          return { fixed: file.name, remember: false };
        }
        return { fixed: undefined, remember: true };
      };
      try {
        return await this.#scanAndProceed(buffer, {
          proceed: async (scanned) => {
            const { fixed, remember } = promised();
            const name = fixed ?? withRandomName(file).name;
            const url = await this.wrapped.save({ ...file, name }, targetDir);
            if (remember) {
              rememberStoredName(this.storedNames, storedBasename(url, name));
            }
            if (scanned) this.#recordCopy(this.#pathOfStoredUrl(url), buffer);
            await this.#writeIconVariants(buffer, this.#pathOfStoredUrl(url));
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
      // Nor is there for a file with no temp path (Ghost's media inliner and
      // oEmbed thumbnails): they write with saveRaw() to the path returned, which
      // never takes a reservation, so one would only be kept for an hour and
      // hand a second file of that name a path that follows the first's.
      const hasTempPath = usable && typeof file.path === 'string' && file.path.length > 0;
      if (!hasTempPath || this.refuseUploadsReason) {
        return unique(usable ? withRandomName(file) : file);
      }
      const key = reservationKey(file, targetDir);
      const reserved = liveReservation(
        this.reservedNames,
        key,
        Date.now(),
        this.lapsedReservations
      );
      if (reserved !== undefined) {
        return unique({ ...file, name: reserved });
      }
      // Asked again before the first ask has finished: the same promise.
      const inFlight = this.namesInFlight.get(key);
      if (inFlight) {
        return inFlight;
      }
      const promise = (async () => {
        try {
          return await this.#promiseName(file, targetDir, key, unique);
        } finally {
          this.namesInFlight.delete(key);
        }
      })();
      this.namesInFlight.set(key, promise);
      return promise;
    }

    async #promiseName(file, targetDir, key, unique) {
      // A file that already lapsed swaps its lapse for the new promise, so it
      // adds nothing to the count and is let through even when the bound is hit.
      if (
        !this.lapsedReservations.has(key) &&
        this.reservedNames.size + this.lapsedReservations.size >= this.reservationMaxEntries
      ) {
        throw buildNamesFullError(GhostErrors);
      }
      const family = claimFamily(this.nameFamilies, file, targetDir, this.reservationMaxEntries);
      try {
        const result = await unique(
          family
            ? { ...file, name: nameWithComponent(file, family.component, family.isOriginal) }
            : withRandomName(file)
        );
        this.reservedNames.set(key, {
          name: path.basename(result),
          expiresAt: Date.now() + RESERVATION_WINDOW_MS,
        });
        // A fresh promise replaces any earlier lapse of the same file.
        this.lapsedReservations.delete(key);
        return result;
      } catch (error) {
        if (family) {
          family.release();
        }
        throw error;
      }
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
        await this.#scanAndProceed(
          buffer,
          {
            proceed: async () => {},
            onHold: async () => {
              throw buildVerdictPendingError(GhostErrors);
            },
          },
          { isMediaUpload: false }
        );
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
      const [fileName, targetDir] = args;
      if (
        this.#isFrozenPath(
          targetDir ? path.posix.join(String(targetDir), String(fileName)) : fileName
        )
      ) {
        return false;
      }
      return this.wrapped.exists(...args);
    }

    read(...args) {
      const [options] = args;
      if (this.#isFrozenPath(options && typeof options === 'object' ? options.path : options)) {
        return Promise.reject(this.#notFoundError());
      }
      return this.wrapped.read(...args);
    }

    urlToPath(...args) {
      return this.wrapped.urlToPath(...args);
    }

    serve(...args) {
      const inner = this.wrapped.serve(...args);
      if (typeof inner !== 'function') return inner;
      // A frozen path answers 404 whether or not the wrapped adapter still
      // holds the bytes, so a copy a freeze could not remove is still not
      // served through Ghost.
      return (req, res, next) => {
        if (req && this.#isFrozenPath(req.path)) {
          res.statusCode = 404;
          res.end();
          return undefined;
        }
        return inner(req, res, next);
      };
    }

    // What a match does once it is made (policy.md). The refusal record is
    // already sealed by tier; this is the part that reaches the copies of the
    // same upload that were stored before the verdict arrived. Never throws
    // past the refusal that called it: a failure here is logged and counted,
    // and the upload is refused all the same.
    async #actOnMatch(digest, hintPath) {
      let record;
      try {
        record = readRefusal(this.quarantinePath, digest);
        this.#count('recordMatch', record.tier);
        this.logger.error(
          `${MATCH_LOG_PREFIX} tier=${record.tier} action=${record.action ?? 'seal'} wraps=${this.wrapsName} digest=${digest}`
        );
        return await this.#freezeCopies(record, digest, hintPath);
      } catch (error) {
        this.logger.error(`${FREEZE_FAILED_LOG_PREFIX} digest=${digest}`, error);
        this.#count('recordFreezeIncomplete');
        return null;
      }
    }

    // Applies a verdict that arrives for bytes already stored (a re-scan that
    // lists a hash that was clean, or a verdict injected by a test): seals or
    // freezes the digest under the same record an upload's refusal writes, then
    // freezes every copy of the family. Returns what it did, or null when the
    // policy does not call the verdict a match or nothing stored has the digest.
    async applyVerdict(digest, verdict) {
      if (this.policy.decide(verdict) !== 'refuse') return null;
      const [found] = familiesToFreeze(this.quarantinePath, this.owner, { digest });
      const copy = found && found.ledger.copies.find((c) => c.digest === digest);
      if (!copy) return null;
      const buffer = await this.#bytesOfCopy(copy);
      await sealRefusal(this.quarantinePath, digest, buffer, verdict, this.computeDigest);
      return this.#actOnMatch(digest, copy.path);
    }

    // Undoes a tier-one freeze from the digest alone: every copy the freeze
    // took out of the served location is written back from quarantine, the
    // family answers present again, and the records go. A tier-two seal is
    // never lifted, nor is a freeze with a seal anywhere in its family; those
    // answer 'sealed' and change nothing. Returns 'lifted', 'not-refused',
    // 'sealed', or 'incomplete' when a copy's bytes could not be put back (the
    // freeze then stays in place).
    async liftFreeze(digest) {
      const record = readRefusal(this.quarantinePath, digest);
      if (record === null) return 'not-refused';
      const found = familiesToFreeze(this.quarantinePath, this.owner, { digest });
      const copyDigests = found.flatMap(({ ledger }) => ledger.copies.map((c) => c.digest));
      const digests = [...new Set([digest, ...copyDigests])];
      for (const d of digests) {
        const r = readRefusal(this.quarantinePath, d);
        if (r !== null && r.tier !== 'one') return 'sealed';
      }
      for (const { ledger } of found) {
        for (const copy of ledger.copies.filter((c) => c.withheld)) {
          try {
            const bytes = await fs.readFile(path.join(this.quarantinePath, copy.digest));
            await this.wrapped.saveRaw(bytes, copy.path);
          } catch (error) {
            this.logger.error(`${LIFT_INCOMPLETE_LOG_PREFIX} path=${copy.path}`, error);
            return 'incomplete';
          }
        }
      }
      for (const { file, ledger } of found) unfreezeFamily(file, ledger);
      for (const d of digests) liftFreeze(this.quarantinePath, d);
      return 'lifted';
    }

    // Reaches every copy: the family of every stored path that has this
    // digest, and the family of the path the matching upload was headed for.
    // The family is marked frozen first, so everything answers absent at once;
    // then each copy is read back, kept under its own digest at the same tier,
    // and removed. A copy that cannot be read is not removed (the bytes are the
    // only record); one the backend refuses to remove is counted, loudly.
    async #freezeCopies(record, digest, hintPath) {
      const family =
        typeof hintPath === 'string' ? familyKeyOf(hintPath, this.storagePath) : undefined;
      const found = familiesToFreeze(this.quarantinePath, this.owner, { digest, family });
      const summary = { families: found.length, copies: 0, withheld: 0, incomplete: 0 };
      for (const { file, ledger } of found) {
        const frozen = markFamilyFrozen(file, ledger, record.tier, record.classification);
        for (const copy of frozen.copies) {
          summary.copies += 1;
          if (await this.#withholdCopy(copy, record)) {
            copy.withheld = true;
            summary.withheld += 1;
          } else {
            summary.incomplete += 1;
            this.#count('recordFreezeIncomplete');
          }
        }
        writeLedger(file, frozen);
      }
      return summary;
    }

    async #withholdCopy(copy, record) {
      let bytes;
      try {
        bytes = await this.#bytesOfCopy(copy);
        await sealRefusal(
          this.quarantinePath,
          this.computeDigest(bytes),
          bytes,
          { classification: record.classification, matchType: record.matchType, source: 'family' },
          this.computeDigest
        );
      } catch (error) {
        this.logger.error(`${FREEZE_INCOMPLETE_LOG_PREFIX} path=${copy.path} step=keep`, error);
        return false;
      }
      // Already taken out by an earlier freeze: only the record above moved.
      if (copy.withheld) return true;
      try {
        const { name, dir } = this.#deleteArgsOf(copy.path);
        await this.wrapped.delete(name, dir);
      } catch (error) {
        // A bucket behind the storage gateway refuses every delete: the copy
        // stays where it is and this adapter can only stop answering for it.
        this.logger.error(`${FREEZE_INCOMPLETE_LOG_PREFIX} path=${copy.path} step=remove`, error);
        return false;
      }
      return true;
    }

    // A copy a freeze already withheld is read back from quarantine, where it
    // is kept; any other from the wrapped adapter, where it is still served.
    async #bytesOfCopy(copy) {
      if (copy.withheld) return fs.readFile(path.join(this.quarantinePath, copy.digest));
      return this.wrapped.read({ path: this.#readPathOf(copy.path) });
    }

    // A path under an absolute storage root is read relative to it (Ghost's
    // local adapter joins the two); any other path is read as it was stored.
    #readPathOf(storedPath) {
      const root = this.storagePath;
      if (typeof root === 'string' && path.isAbsolute(root) && storedPath.startsWith(`${root}/`)) {
        return storedPath.slice(root.length + 1);
      }
      return storedPath;
    }

    // Ghost's local adapter deletes `path.join(targetDir, fileName)`, so a
    // path stored relative to an absolute root is made absolute first.
    #deleteArgsOf(storedPath) {
      const name = path.posix.basename(storedPath);
      const dir = path.posix.dirname(storedPath);
      const root = this.storagePath;
      if (typeof root === 'string' && path.isAbsolute(root) && !path.isAbsolute(storedPath)) {
        return { name, dir: path.posix.join(root, dir) };
      }
      return { name, dir };
    }

    // A metric a test double may not implement, and one that is not wired.
    #count(method, ...args) {
      if (typeof this.metrics?.[method] === 'function') this.metrics[method](...args);
    }

    #recordCopy(storedPath, buffer) {
      try {
        if (typeof storedPath !== 'string' || storedPath === '') {
          throw new Error('the stored path is unknown');
        }
        recordCopy(
          this.quarantinePath,
          this.owner,
          this.storagePath,
          storedPath,
          this.computeDigest(buffer)
        );
      } catch (error) {
        // The object is already stored; failing the upload now would not
        // undo it. A copy missing from the ledger is one a freeze cannot
        // reach, so it is said aloud.
        this.logger.error(`${COPY_LEDGER_FAILED_LOG_PREFIX} wraps=${this.wrapsName}`, error);
      }
    }

    // The freeze of the family a stored path belongs to, or null. An
    // unreadable ledger answers frozen: it is where a freeze would be.
    #frozenOf(storedPath) {
      if (typeof storedPath !== 'string' || storedPath === '') return null;
      try {
        return frozenOf(this.quarantinePath, this.owner, this.storagePath, storedPath);
      } catch (error) {
        this.logger.error(
          `${COPY_LEDGER_FAILED_LOG_PREFIX} wraps=${this.wrapsName} step=read`,
          error
        );
        return { tier: 'two', classification: null };
      }
    }

    #isFrozenPath(storedPath) {
      return this.#frozenOf(storedPath) !== null;
    }

    #refuseIfFrozen(targetPath) {
      const frozen = this.#frozenOf(targetPath);
      if (frozen === null) return;
      if (this.metrics) {
        this.metrics.recordRefusal('sealed');
      }
      throw buildRefusalError(
        GhostErrors,
        { classification: frozen.classification ?? 'csam' },
        AUDIENCE.TENANT_STAFF
      );
    }

    #notFoundError() {
      if (typeof GhostErrors.NotFoundError === 'function') {
        return new GhostErrors.NotFoundError({ message: 'Could not find image.' });
      }
      return Object.assign(new Error('Could not find image.'), { code: 'ENOENT' });
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

    // Video and audio have no automated check, so what they are decides
    // their fate before any hashing, record lookup, check, quarantine write
    // or hold. Decided from the bytes alone, whichever feature or entry point
    // carried them. A tier that accepts them stores them unchecked: nothing
    // here records a verdict or says they were scanned (see tier-policy.md).
    #decideVideoAudio(family, proceed) {
      if (this.allowVideoAudio) {
        // Stored unchecked: no verdict will ever name it, so it is not in the
        // copy ledger either.
        return this.#proceedWithWriteTimeout(proceed, false);
      }
      if (this.metrics) {
        this.metrics.recordRefusal('video-audio');
      }
      this.logger.error(
        `ScanningStorageAdapter: UPLOAD_REFUSED_VIDEO_AUDIO wraps=${this.wrapsName} family=${family}`
      );
      throw buildVideoAudioRefusedError(GhostErrors);
    }

    async #proceedWithWriteTimeout(proceed, scanned = true) {
      try {
        return await withWriteTimeout(proceed(scanned), this.writeTimeoutMs);
      } catch (err) {
        if (isWriteTimeoutError(err)) {
          this.logger.error(REQUEST_WRITE_TIMEOUT_LOG_PREFIX, err);
        }
        throw err;
      }
    }

    // `isMediaUpload` is false only for a theme tree, whose files are served
    // as theme assets and are not uploads to a media feature.
    async #scanAndProceed(buffer, { proceed, onHold, hintPath }, { isMediaUpload = true } = {}) {
      const videoAudioFamily = isMediaUpload ? detectVideoAudioFamily(buffer) : null;
      if (videoAudioFamily !== null) {
        return this.#decideVideoAudio(videoAudioFamily, proceed);
      }
      // A digest any feature has refused stays refused here too, whatever a
      // verdict would say now: positive verdicts never expire.
      const digest = this.computeDigest(buffer);
      const sealed = readRefusal(this.quarantinePath, digest);
      if (sealed) {
        await sealRefusal(this.quarantinePath, digest, buffer, sealed, this.computeDigest);
        if (this.metrics) {
          this.metrics.recordRefusal('sealed');
        }
        throw buildRefusalError(GhostErrors, sealed, AUDIENCE.TENANT_STAFF);
      }

      const { decision, verdict } = await evaluate(this.checks, this.policy, buffer);

      if (decision === 'allow') {
        // Another feature may have sealed this digest while the verdict was
        // in flight.
        const sealedSince = readRefusal(this.quarantinePath, digest);
        if (sealedSince) {
          await sealRefusal(this.quarantinePath, digest, buffer, sealedSince, this.computeDigest);
          if (this.metrics) {
            this.metrics.recordRefusal('sealed');
          }
          throw buildRefusalError(GhostErrors, sealedSince, AUDIENCE.TENANT_STAFF);
        }
        return this.#proceedWithWriteTimeout(proceed);
      }

      if (decision === 'refuse') {
        await sealRefusal(
          this.quarantinePath,
          verdict.evidence,
          buffer,
          verdict,
          this.computeDigest
        );
        if (this.metrics) {
          this.metrics.recordRefusal('verdict');
        }
        await this.#actOnMatch(verdict.evidence, hintPath);
        throw buildRefusalError(GhostErrors, verdict, AUDIENCE.TENANT_STAFF);
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

    // True where Ghost core builds absolute bucket URLs for images: an
    // object-storage adapter serving the images feature. The local adapters
    // serve /content/images/size/... through Ghost's own middleware, and the
    // other features are never resized.
    #isBucketImages() {
      return (
        Boolean(this.wrappedConfig && this.wrappedConfig.bucket) &&
        typeof this.storagePath === 'string' &&
        path.posix.basename(this.storagePath) === 'images'
      );
    }

    #writesIconVariants() {
      return this.#isBucketImages() && Boolean(this.imageTransform);
    }

    // The path under the adapter's storage root that the wrapped adapter
    // stored a URL at, or null when it cannot say.
    #pathOfStoredUrl(url) {
      if (typeof this.wrapped.urlToPath !== 'function') {
        return null;
      }
      try {
        return this.wrapped.urlToPath(url);
      } catch (error) {
        return null;
      }
    }

    // Writes the size variants Ghost core asks the bucket for, after the
    // image itself is stored. The variants go through this decorator's own
    // saveRaw, so they are scanned like every other byte served from the
    // bucket. Best effort: the upload has already succeeded, and the same
    // variant is still made on demand when the request does reach Ghost.
    async #writeIconVariants(buffer, storedPath) {
      if (!this.#writesIconVariants() || typeof storedPath !== 'string') {
        return;
      }
      const storageRoot = `${this.storagePath.replace(/^\/+|\/+$/g, '')}/`;
      let relative = storedPath.replace(/^\/+/, '');
      if (relative.startsWith(storageRoot)) {
        relative = relative.slice(storageRoot.length);
      }
      // A variant is never itself resized, and the _o original is never
      // asked for at a size.
      if (relative === '' || relative.startsWith('size/') || ORIGINAL_NAME_PATTERN.test(relative)) {
        return;
      }
      const ext = path.posix.extname(relative).toLowerCase();
      try {
        for (const format of iconVariantFormats(ext, this.imageTransform)) {
          const resized = await this.imageTransform.resizeFromBuffer(buffer, {
            withoutEnlargement: ext !== '.svg',
            ...ICON_SIZE,
            format,
            timeout: ICON_RESIZE_TIMEOUT_SECONDS,
          });
          const variantDir = format
            ? `size/${ICON_SIZE_DIR}/format/${format}`
            : `size/${ICON_SIZE_DIR}`;
          await this.saveRaw(resized, `${variantDir}/${relative}`);
        }
      } catch (error) {
        this.logger.error(`${ICON_VARIANT_FAILED_LOG_PREFIX} path=${relative}`, error);
      }
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
          this.#recordCopy(targetPath, heldBuffer);
          await this.#writeIconVariants(heldBuffer, targetPath);
        },
        // Nothing was written for a hold, so there is nothing of its own to
        // undo; but a sibling copy of the same upload may already be served.
        onRefuse: async (digest) => {
          if (typeof digest === 'string') await this.#actOnMatch(digest, targetPath);
        },
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
      const { cdnUrl, endpoint, bucket, tenantPrefix } = this.wrappedConfig;
      if (bucket) {
        const base = cdnUrl || (endpoint ? `${endpoint.replace(/\/$/, '')}/${bucket}` : null);
        if (!base) {
          throw new Error(
            'ScanningStorageAdapter: an object-storage hold needs wrappedConfig.cdnUrl, or .endpoint and .bucket, to build a URL'
          );
        }
        // Ghost stores a tenant's keys under tenantPrefix when it is set, so
        // the served URL carries the same segment: <base>/<prefix>/<path>.
        const prefix =
          typeof tenantPrefix === 'string' ? tenantPrefix.replace(/^\/+|\/+$/g, '') : '';
        const key = prefix ? `${prefix}/${normalized}` : normalized;
        return `${base.replace(/\/$/, '')}/${key}`;
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
