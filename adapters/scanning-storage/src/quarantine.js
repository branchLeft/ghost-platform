'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

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
// Every orphan the sweep removes is logged with this prefix, so a log search
// or alert has one fixed string to match.
const ORPHAN_LOG_PREFIX = 'ScanningStorageAdapter: orphaned quarantine bytes';

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

// Fails closed like isRefused: only a missing sidecar means "no hold". Only
// presence is read, so a sidecar nobody can parse still counts as a hold.
function hasHoldSidecar(quarantinePath, digest) {
  return (
    fsSync.statSync(path.join(quarantinePath, `${digest}${HOLDS_SUFFIX}`), {
      throwIfNoEntry: false,
    }) !== undefined
  );
}

// Returns the verdict a refusal was recorded with, or null when the digest
// was never refused. A record that exists but cannot be parsed is still a
// refusal: it reads back as one with no classification, which the refusal
// error words generically.
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
      return { ...parsed, evidence: digest };
    }
  } catch {
    // fall through
  }
  return { classification: 'csam', evidence: digest };
}

// Record first, bytes second: see the README's "Sealing order", which also
// covers releaseBytes. `onRecordWritten` is a test seam between the steps.
async function sealRefusal(
  quarantinePath,
  digest,
  buffer,
  verdict,
  computeDigest,
  { onRecordWritten } = {}
) {
  if (!isRefused(quarantinePath, digest)) {
    await fs.mkdir(quarantinePath, { recursive: true });
    await writeFileAtomic(
      refusalPath(quarantinePath, digest),
      JSON.stringify({
        classification: verdict && verdict.classification,
        matchType: verdict && verdict.matchType,
        source: verdict && verdict.source,
      })
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
// digest's bytes) when the digest is refused, deleted otherwise. A copy
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
      if (!isRefused(quarantinePath, digest)) {
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
    name.endsWith(REFUSED_SUFFIX)
  );
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

// Bytes with neither a hold sidecar nor a refusal record, older than
// `minAgeMs`, are what a crash between a hold's two writes leaves behind:
// nothing records which target path they were for, so they can only be
// removed. Removal goes through releaseBytes, which checks again after the
// move aside, so a hold or a refusal that lands meanwhile wins. Every
// failure on a file is logged and leaves it in place. `now` and
// `onMovedAside` are test seams. Throws when the directory cannot be
// listed, and returns how many orphans were removed.
function sweepOrphans(quarantinePath, { minAgeMs, now = Date.now, logger, onMovedAside }) {
  const names = listEntries(quarantinePath).filter(isOrphanCandidateName);
  const nowMs = now();
  let removed = 0;
  for (const name of names) {
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

module.exports = {
  REFUSED_SUFFIX,
  HOLDS_SUFFIX,
  ORPHAN_LOG_PREFIX,
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
