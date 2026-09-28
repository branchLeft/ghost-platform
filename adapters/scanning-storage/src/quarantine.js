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

// Record first, bytes second: see the README's "Sealing order". Matching
// bytes are left alone, since another feature may be reading them.
async function sealRefusal(quarantinePath, digest, buffer, verdict, computeDigest) {
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
  if (!(await quarantinedBytesMatch(quarantinePath, digest, computeDigest))) {
    await quarantineBytes(quarantinePath, digest, buffer);
  }
}

module.exports = {
  REFUSED_SUFFIX,
  quarantineBytes,
  quarantinedBytesMatch,
  writeFileAtomic,
  writeFileAtomicSync,
  isRefused,
  readRefusal,
  sealRefusal,
};
