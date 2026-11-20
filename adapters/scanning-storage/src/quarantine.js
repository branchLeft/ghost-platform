'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const { tierOf, TIER_ONE, TIER_TWO } = require('./policy');

// A refusal record sits next to the refused bytes. Its presence is what
// makes a digest refused for every feature sharing this quarantine
// directory, for good: positive verdicts never expire, so nothing that
// reads this directory may promote, overwrite or delete bytes it names.
const REFUSED_SUFFIX = '.refused.json';
// Sidecar suffix recording which target paths are waiting on a digest, so a
// restart can tell a still-pending hold apart from a permanently quarantined
// refusal -- both live at `<quarantinePath>/<digest>`, but only a hold has
// one of these next to it.
const HOLDS_SUFFIX = '.holds.json';
// Sidecar suffix for a family's copy ledger: which stored paths one upload
// made (the processed image, its `_o` original, any responsive derivative),
// so a freeze can reach every one of them. See recordCopy().
const COPIES_SUFFIX = '.copies.json';
// Every orphan the sweep removes is logged with this prefix, so a log search
// or alert has one fixed string to match.
const ORPHAN_LOG_PREFIX = 'ScanningStorageAdapter: orphaned quarantine bytes';
// The same for a crash-residue temp file the sweep removes.
const TEMP_LOG_PREFIX = 'ScanningStorageAdapter: crash-residue quarantine temp file';
// A temp file a live writer owns is only ever as old as the write timeout (60
// seconds by default). No sweep removes a temp file younger than this, however
// small the orphan age it was given.
const TEMP_MIN_AGE_FLOOR_MS = 60_000;
// Exactly the name tempNameFor makes: `.<target>.<pid>.<12 hex digits>.tmp`.
const TEMP_NAME_PATTERN = /^\..+\.\d+\.[0-9a-f]{12}\.tmp$/;

function tempNameFor(target) {
  // Leading dot and a trailing .tmp: never a digest, never a sidecar, so no
  // reader of this directory can mistake a half-written file for either.
  const suffix = `${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  return path.join(path.dirname(target), `.${path.basename(target)}.${suffix}`);
}

// The rename is what makes a reader see either the old file or the whole
// new one, never a prefix. The fsyncs make that still true after a power
// loss: without the file fsync the rename can land before the data, and
// without the directory fsync the rename itself may not survive.
async function writeFileAtomic(target, data) {
  const temp = tempNameFor(target);
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
  await fsyncDir(path.dirname(target));
}

// Synchronous twin for the sidecar's read-modify-write, which must not
// yield to another registry between its read and its write.
function writeFileAtomicSync(target, data) {
  const temp = tempNameFor(target);
  const fd = fsSync.openSync(temp, 'wx');
  try {
    fsSync.writeFileSync(fd, data);
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
  try {
    fsSync.renameSync(temp, target);
  } catch (err) {
    fsSync.rmSync(temp, { force: true });
    throw err;
  }
  fsyncDirSync(path.dirname(target));
}

async function fsyncDir(dir) {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Some filesystems refuse to fsync a directory; the rename has still
    // happened, only its durability across a power loss is weaker.
  } finally {
    if (handle) await handle.close();
  }
}

function fsyncDirSync(dir) {
  let fd;
  try {
    fd = fsSync.openSync(dir, 'r');
    fsSync.fsyncSync(fd);
  } catch {
    // As fsyncDir.
  } finally {
    if (fd !== undefined) fsSync.closeSync(fd);
  }
}

// Refused bytes are named by digest, never by the uploader's filename: a
// filename cannot be chosen to collide with, or overwrite, another tenant's
// quarantined object.
async function quarantineBytes(quarantinePath, digest, buffer) {
  await fs.mkdir(quarantinePath, { recursive: true });
  const target = path.join(quarantinePath, digest);
  await writeFileAtomic(target, buffer);
  return target;
}

// True when the bytes on disk under `digest` are exactly the bytes that
// digest names. A missing file is not a match.
async function quarantinedBytesMatch(quarantinePath, digest, computeDigest) {
  try {
    const buffer = await fs.readFile(path.join(quarantinePath, digest));
    return computeDigest(buffer) === digest;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function refusalPath(quarantinePath, digest) {
  return path.join(quarantinePath, `${digest}${REFUSED_SUFFIX}`);
}

// Fails closed: only a missing record means "not refused". Any other stat
// error throws, so no caller can read it as licence to promote or delete.
function isRefused(quarantinePath, digest) {
  return (
    fsSync.statSync(refusalPath(quarantinePath, digest), { throwIfNoEntry: false }) !== undefined
  );
}

// An older release wrote the sidecar as one file. Splitting it into one entry
// per owner renames the file to a dotfile "aside" copy first, and removes the
// copy only once every entry has landed (see hold.js). While the copy exists
// it is the only record of the hold, so it is a hold on `digest` exactly as a
// sidecar is. The first capture is the digest the copy names.
const SPLIT_ASIDE_NAME = /^\.(.+?)\.holds\.json\.[^.]+\.json$/;

// True when an unfinished split's aside copy names `digest`. Fails closed: a
// listing error other than a missing directory throws, so no caller reads it
// as "no hold".
function hasSplitAside(quarantinePath, digest) {
  let names;
  try {
    names = fsSync.readdirSync(quarantinePath);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  return names.some((name) => {
    const match = SPLIT_ASIDE_NAME.exec(name);
    return match !== null && match[1] === digest;
  });
}

// Fails closed like isRefused: only a missing sidecar means "no hold". Only
// presence is read, so a sidecar nobody can parse still counts as a hold. An
// unfinished split's aside copy counts too: a failed split (a full disk, say)
// leaves the copy with no sidecar, or an empty one, standing, and the bytes
// stay held until a later split completes.
function hasHoldSidecar(quarantinePath, digest) {
  const sidecar = fsSync.statSync(path.join(quarantinePath, `${digest}${HOLDS_SUFFIX}`), {
    throwIfNoEntry: false,
  });
  return sidecar !== undefined || hasSplitAside(quarantinePath, digest);
}

// Returns the verdict a refusal was recorded with, or null when the digest
// was never refused. A record that exists but cannot be parsed is still a
// refusal: it reads back as one with no classification, which the refusal
// error words generically. `tier` is what the record says, or what the
// verdict derives when an older release wrote it without one; a record that
// cannot be read is tier two, so nothing ever lifts it.
function readRefusal(quarantinePath, digest) {
  let raw;
  try {
    raw = fsSync.readFileSync(refusalPath(quarantinePath, digest), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const tier =
        parsed.tier === TIER_ONE || parsed.tier === TIER_TWO
          ? parsed.tier
          : (tierOf(parsed) ?? TIER_TWO);
      return { ...parsed, tier, evidence: digest };
    }
  } catch {
    // fall through
  }
  return { classification: 'csam', tier: TIER_TWO, evidence: digest };
}

// The record a match is sealed with. The tier says what was done: a tier-two
// match is a seal (`sealedAt` is when the reporting clock started), a tier-one
// match a freeze (`frozenAt`). Neither carries anything but the verdict's own
// fields and a time, so the record itself is safe to hand to a reviewer.
function recordFor(verdict, tier, existing, nowIso) {
  const record = {
    classification: verdict && verdict.classification,
    matchType: verdict && verdict.matchType,
    source: verdict && verdict.source,
    tier,
    action: tier === TIER_TWO ? 'seal' : 'freeze',
  };
  if (existing && existing.frozenAt) record.frozenAt = existing.frozenAt;
  if (tier === TIER_TWO) record.sealedAt = (existing && existing.sealedAt) || nowIso;
  else record.frozenAt = (existing && existing.frozenAt) || nowIso;
  return record;
}

// Record first, bytes second: see the README's "Sealing order", which also
// covers releaseBytes. `onRecordWritten` is a test seam between the steps.
// A refused digest is never downgraded: a tier-one freeze is replaced by a
// tier-two seal when a later verdict says exact, and a seal is never
// replaced by anything. `now` is a test seam for the clock the seal starts.
async function sealRefusal(
  quarantinePath,
  digest,
  buffer,
  verdict,
  computeDigest,
  { onRecordWritten, now = () => new Date().toISOString() } = {}
) {
  // A refused digest that no policy tier names (a caller passing a bare
  // verdict) is a freeze, the reversible one.
  const tier = tierOf(verdict) ?? TIER_ONE;
  const existing = isRefused(quarantinePath, digest) ? readRefusal(quarantinePath, digest) : null;
  if (!existing || (existing.tier === TIER_ONE && tier === TIER_TWO)) {
    await fs.mkdir(quarantinePath, { recursive: true });
    await writeFileAtomic(
      refusalPath(quarantinePath, digest),
      JSON.stringify(recordFor(verdict, tier, existing, now()))
    );
  }
  if (onRecordWritten) await onRecordWritten();
  if (await quarantinedBytesMatch(quarantinePath, digest, computeDigest)) return;
  for (const aside of asideCopiesOf(quarantinePath, digest)) {
    restoreAside(aside, path.join(quarantinePath, digest));
    if (await quarantinedBytesMatch(quarantinePath, digest, computeDigest)) return;
  }
  await quarantineBytes(quarantinePath, digest, buffer);
}

const RELEASING_INFIX = '.releasing.';

// Only called once the record is in place, so the directory exists.
function asideCopiesOf(quarantinePath, digest) {
  const prefix = `${digest}${RELEASING_INFIX}`;
  return fsSync
    .readdirSync(quarantinePath)
    .filter((n) => n.startsWith(prefix))
    .map((n) => path.join(quarantinePath, n));
}

// Someone else (a sealer, the sweep, another releaser) may already have
// moved it back.
function restoreAside(aside, target) {
  try {
    fsSync.renameSync(aside, target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Removes unrefused bytes, safely against a sealer in another process:
// move them aside under a unique name, THEN check for a refusal record, and
// put them back if there is one. Only the aside name is ever unlinked.
// `keepIfHeld` makes a hold sidecar count like a record, for the orphan
// sweep, which must never remove bytes a hold is waiting on. Returns true
// when the bytes were removed. `onMovedAside` is a test seam.
function releaseBytes(quarantinePath, digest, { onMovedAside, keepIfHeld = false } = {}) {
  const target = path.join(quarantinePath, digest);
  const aside = `${target}${RELEASING_INFIX}${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fsSync.renameSync(target, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (onMovedAside) onMovedAside();
  let keep;
  try {
    keep =
      isRefused(quarantinePath, digest) || (keepIfHeld && hasHoldSidecar(quarantinePath, digest));
  } catch (err) {
    restoreAside(aside, target);
    throw err;
  }
  if (keep) {
    restoreAside(aside, target);
    return false;
  }
  fsSync.rmSync(aside, { force: true });
  return true;
}

// Aside copies left by a releaser that died mid-release: kept (as the
// digest's bytes) when the digest is refused or a hold sidecar names it,
// deleted otherwise. A hold may land its sidecar after the releaser moved the
// bytes aside, so the copy may be the only one a hold is waiting on. A copy
// whose digest cannot be checked is left for the next sweep.
function sweepReleasing(quarantinePath, computeDigest, logger) {
  let names;
  try {
    names = fsSync.readdirSync(quarantinePath);
  } catch {
    return;
  }
  for (const name of names) {
    const at = name.indexOf(RELEASING_INFIX);
    if (at <= 0) continue;
    const digest = name.slice(0, at);
    const aside = path.join(quarantinePath, name);
    const target = path.join(quarantinePath, digest);
    try {
      if (!isRefused(quarantinePath, digest) && !hasHoldSidecar(quarantinePath, digest)) {
        fsSync.rmSync(aside, { force: true });
        continue;
      }
      let current = null;
      try {
        current = fsSync.readFileSync(target);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (current && computeDigest(current) === digest) {
        fsSync.rmSync(aside, { force: true });
      } else {
        restoreAside(aside, target);
      }
    } catch (err) {
      logger.error(`ScanningStorageAdapter: could not sweep ${name}; left in place`, err);
    }
  }
}

// Dotfiles are temp files a live writer may own; asides belong to
// sweepReleasing; sidecars and records are not bytes.
function isOrphanCandidateName(name) {
  return !(
    name.startsWith('.') ||
    name.includes(RELEASING_INFIX) ||
    name.endsWith(HOLDS_SUFFIX) ||
    name.endsWith(COPIES_SUFFIX) ||
    name.endsWith(REFUSED_SUFFIX)
  );
}

// A dotfile left by writeFileAtomic, by name alone. Any other dotfile is not
// ours to remove.
function isCrashResidueTempName(name) {
  return TEMP_NAME_PATTERN.test(name);
}

// Milliseconds since a regular file was written; null for anything else
// (gone since the listing, a directory, a symlink), which is never touched.
function ageOfRegularFile(file, nowMs) {
  let stat;
  try {
    stat = fsSync.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return stat.isFile() ? nowMs - stat.mtimeMs : null;
}

function listEntries(quarantinePath) {
  try {
    return fsSync.readdirSync(quarantinePath);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Returns the age of the orphan it removed, or null when it left the file
// alone: too young, not plain bytes, or a hold or a refusal names it.
function removeIfOrphan(quarantinePath, name, { nowMs, minAgeMs, onMovedAside }) {
  const ageMs = ageOfRegularFile(path.join(quarantinePath, name), nowMs);
  if (ageMs === null || ageMs <= minAgeMs) return null;
  if (isRefused(quarantinePath, name) || hasHoldSidecar(quarantinePath, name)) return null;
  return releaseBytes(quarantinePath, name, { keepIfHeld: true, onMovedAside }) ? ageMs : null;
}

// Returns the age of the temp file it removed, or null when it left the file
// alone: too young, or not a regular file. A temp file holds no verdict and is
// never served, so there is nothing to check beside its age. The name is
// unique to one write, so it cannot be a file written after the stat.
function removeIfCrashResidue(quarantinePath, name, { nowMs, minAgeMs }) {
  const file = path.join(quarantinePath, name);
  const ageMs = ageOfRegularFile(file, nowMs);
  if (ageMs === null || ageMs <= Math.max(minAgeMs, TEMP_MIN_AGE_FLOOR_MS)) return null;
  fsSync.rmSync(file, { force: true });
  return ageMs;
}

// Bytes with neither a hold sidecar nor a refusal record, older than
// `minAgeMs`, are what a crash between a hold's two writes leaves behind:
// nothing records which target path they were for, so they can only be
// removed. Removal goes through releaseBytes, which checks again after the
// move aside, so a hold or a refusal that lands meanwhile wins. Every
// failure on a file is logged and leaves it in place. `now` and
// `onMovedAside` are test seams. Throws when the directory cannot be
// listed, and returns how many orphans and temp files were removed.
//
// The same sweep removes crash-residue temp files (see isCrashResidueTempName):
// a regular file with exactly the name writeFileAtomic gives its temp file,
// older than `minAgeMs` and than TEMP_MIN_AGE_FLOOR_MS, because a crash between
// that write and its rename is the only way one stays.
function sweepOrphans(quarantinePath, { minAgeMs, now = Date.now, logger, onMovedAside }) {
  const entries = listEntries(quarantinePath);
  const nowMs = now();
  let removed = 0;
  for (const name of entries.filter(isCrashResidueTempName)) {
    try {
      const ageMs = removeIfCrashResidue(quarantinePath, name, { nowMs, minAgeMs });
      if (ageMs === null) continue;
      removed += 1;
      logger.error(`${TEMP_LOG_PREFIX} ${name} (${Math.round(ageMs)} ms old); removed`);
    } catch (err) {
      logger.error(`ScanningStorageAdapter: could not sweep temp file ${name}; left in place`, err);
    }
  }
  for (const name of entries.filter(isOrphanCandidateName)) {
    try {
      const ageMs = removeIfOrphan(quarantinePath, name, { nowMs, minAgeMs, onMovedAside });
      if (ageMs === null) continue;
      removed += 1;
      logger.error(`${ORPHAN_LOG_PREFIX} ${name} (${Math.round(ageMs)} ms old); removed`);
    } catch (err) {
      logger.error(
        `ScanningStorageAdapter: could not sweep orphan candidate ${name}; left in place`,
        err
      );
    }
  }
  return removed;
}

// A refusal that is a tier-one freeze can be lifted, and nothing else can:
// the record goes, so the digest is no longer refused, and the caller puts
// back what the freeze withheld. A seal (tier two) and a record that cannot
// be read are never lifted. Returns 'lifted', 'not-refused' or 'sealed'.
function liftFreeze(quarantinePath, digest) {
  const record = readRefusal(quarantinePath, digest);
  if (record === null) return 'not-refused';
  if (record.tier !== TIER_ONE) return 'sealed';
  fsSync.rmSync(refusalPath(quarantinePath, digest), { force: true });
  return 'lifted';
}

// ---- The copy ledger -------------------------------------------------------
//
// One upload becomes several objects: Ghost stores the processed image and an
// untouched `_o` original, and later (or at once, on a bucket) a responsive
// derivative per size and format. They share a name and nothing else: their
// bytes, so their digests, differ. A freeze that reached only the bytes a
// verdict named would leave the others served, so every write is recorded
// here under a family key built from its path alone.

const SIZE_DIR = /^size\/[^/]+\//;
const FORMAT_DIR = /^format\/[^/]+\//;

// The path an object sits at, relative to the storage root, with the parts
// that tell copies of one upload apart taken off: the root, the `size/<w>/`
// and `format/<f>/` directories a derivative sits under, and the `_o` before
// the extension an original carries.
function familyKeyOf(storedPath, storageRoot) {
  let relative = String(storedPath).split(path.sep).join('/').replace(/^\/+/, '');
  const root = String(storageRoot ?? '')
    .split(path.sep)
    .join('/')
    .replace(/^\/+|\/+$/g, '');
  if (root !== '' && relative.startsWith(`${root}/`)) relative = relative.slice(root.length + 1);
  relative = relative.replace(SIZE_DIR, '').replace(FORMAT_DIR, '');
  const ext = path.posix.extname(relative);
  const stem = relative.slice(0, relative.length - ext.length).replace(/_o$/, '');
  return `${stem}${ext}`;
}

function ledgerPath(quarantinePath, owner, familyKey) {
  const id = crypto.createHash('sha256').update(`${owner}\0${familyKey}`).digest('hex');
  return path.join(quarantinePath, `${id}${COPIES_SUFFIX}`);
}

// A missing ledger is null; one that exists and cannot be read as a ledger
// throws, so no caller takes "cannot tell" for "nothing frozen". The adapter
// answers a path frozen when the ledger it would be in is unreadable.
function readLedger(file) {
  let raw;
  try {
    raw = fsSync.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`copy ledger ${path.basename(file)} cannot be parsed`);
  }
  if (!parsed || !Array.isArray(parsed.copies)) {
    throw new Error(`copy ledger ${path.basename(file)} has no list of copies`);
  }
  return parsed;
}

// Remembers that `storedPath` now holds the bytes named `digest`. Synchronous
// from read to write, so two writers in one process cannot lose each other's
// entry; the rename inside writeFileAtomicSync covers a reader in another.
function recordCopy(quarantinePath, owner, storageRoot, storedPath, digest) {
  const family = familyKeyOf(storedPath, storageRoot);
  const file = ledgerPath(quarantinePath, owner, family);
  fsSync.mkdirSync(quarantinePath, { recursive: true });
  const ledger = readLedger(file) ?? { owner, family, copies: [] };
  const known = ledger.copies.find((c) => c.path === storedPath);
  if (known) known.digest = digest;
  else ledger.copies.push({ path: storedPath, digest });
  writeFileAtomicSync(file, JSON.stringify(ledger));
  return family;
}

// Every ledger of this owner that holds a copy named `digest`, or that is
// `family`'s own. A directory that cannot be listed is empty, so a freeze on a
// host that never stored anything finds nothing and does not throw.
function familiesToFreeze(quarantinePath, owner, { digest, family }) {
  const found = [];
  for (const name of listEntries(quarantinePath).filter((n) => n.endsWith(COPIES_SUFFIX))) {
    const file = path.join(quarantinePath, name);
    let ledger;
    try {
      ledger = readLedger(file);
    } catch {
      // Cannot be tied to a family or a digest; frozenOf() still answers
      // frozen for any path whose own ledger this is.
      continue;
    }
    if (ledger === null || ledger.owner !== owner) continue;
    if (ledger.family === family || ledger.copies.some((c) => c.digest === digest)) {
      found.push({ file, ledger });
    }
  }
  return found;
}

// Writes a ledger back, whole and atomically.
function writeLedger(file, ledger) {
  writeFileAtomicSync(file, JSON.stringify(ledger));
}

// A family is frozen once any of its copies matched. Recorded in the ledger so
// a restart still answers absent for every path in it. A seal is never
// replaced by a freeze.
function markFamilyFrozen(file, ledger, tier, classification) {
  const already = ledger.frozen;
  const next = {
    ...ledger,
    frozen:
      already && already.tier === TIER_TWO
        ? already
        : { tier, classification: classification ?? null },
  };
  writeLedger(file, next);
  return next;
}

// Takes the freeze off a family and says each copy is back where it was. Only
// ever called after liftFreeze() has agreed every record is tier one.
function unfreezeFamily(file, ledger) {
  const { frozen: _frozen, ...rest } = ledger;
  writeLedger(file, {
    ...rest,
    copies: ledger.copies.map(({ withheld: _withheld, ...copy }) => copy),
  });
}

// What froze the family `storedPath` belongs to, or null when nothing did.
// Throws on a ledger that cannot be read, so the caller decides what an
// unreadable answer means.
function frozenOf(quarantinePath, owner, storageRoot, storedPath) {
  const ledger = readLedger(
    ledgerPath(quarantinePath, owner, familyKeyOf(storedPath, storageRoot))
  );
  return ledger !== null && ledger.frozen ? ledger.frozen : null;
}

module.exports = {
  COPIES_SUFFIX,
  familyKeyOf,
  recordCopy,
  familiesToFreeze,
  markFamilyFrozen,
  writeLedger,
  unfreezeFamily,
  frozenOf,
  liftFreeze,
  REFUSED_SUFFIX,
  HOLDS_SUFFIX,
  SPLIT_ASIDE_NAME,
  ORPHAN_LOG_PREFIX,
  TEMP_LOG_PREFIX,
  TEMP_MIN_AGE_FLOOR_MS,
  quarantineBytes,
  quarantinedBytesMatch,
  writeFileAtomic,
  writeFileAtomicSync,
  isRefused,
  readRefusal,
  sealRefusal,
  releaseBytes,
  sweepReleasing,
  sweepOrphans,
  RELEASING_INFIX,
};
