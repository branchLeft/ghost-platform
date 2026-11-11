'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// The host end's durable queue of unverdicted hashes, plus a short memory of
// the verdicts that came back. Both live in one append-only journal that is
// replayed at start, so a restart loses nothing that was waiting. Behaviour
// and limits: verdict-host.md.

const MAX_BATCH_HASHES = 500;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_REOFFER_DELAY_MS = 30_000;
const DEFAULT_VERDICT_TTL_MS = 600_000;
const DEFAULT_MAX_QUEUED = 10_000;
const DEFAULT_COMPACT_AFTER = 10_000;

const RECORD_QUEUED = 'q';
const RECORD_VERDICT = 'v';

const OPEN_APPEND = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function openJournal(file) {
  return fs.openSync(file, OPEN_APPEND | NO_FOLLOW, 0o600);
}

function readJournalLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, { encoding: 'utf8', flag: fs.constants.O_RDONLY | NO_FOLLOW });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // The text after the last newline is a record that was being written when
  // the process stopped; it is dropped, never half-read.
  const lines = text.split('\n');
  lines.pop();
  return lines;
}

function parseRecord(line) {
  try {
    const record = JSON.parse(line);
    if (record === null || typeof record !== 'object') return null;
    if (typeof record.h !== 'string' || !Number.isFinite(record.at)) return null;
    if (record.t === RECORD_QUEUED) return record;
    if (record.t === RECORD_VERDICT && typeof record.c === 'string') return record;
    return null;
  } catch {
    return null;
  }
}

class VerdictQueue extends EventEmitter {
  #journalFile;
  #now;
  #leaseMs;
  #reofferDelayMs;
  #verdictTtlMs;
  #maxQueued;
  #compactAfter;
  #logger;
  #fd = null;
  #appends = 0;
  // hash -> { queuedAt, notBefore, batch }. Map order is queued order.
  #items = new Map();
  // hash -> { classification, matchType, at }
  #verdicts = new Map();
  // batch -> { hashes, expiresAt }
  #batches = new Map();

  constructor({
    journalFile,
    now = Date.now,
    leaseMs = DEFAULT_LEASE_MS,
    reofferDelayMs = DEFAULT_REOFFER_DELAY_MS,
    verdictTtlMs = DEFAULT_VERDICT_TTL_MS,
    maxQueued = DEFAULT_MAX_QUEUED,
    compactAfter = DEFAULT_COMPACT_AFTER,
    logger = console,
  } = {}) {
    super();
    if (typeof journalFile !== 'string' || !path.isAbsolute(journalFile)) {
      throw new Error('VerdictQueue requires an absolute journalFile');
    }
    for (const [name, value] of Object.entries({
      leaseMs,
      reofferDelayMs,
      verdictTtlMs,
      maxQueued,
      compactAfter,
    })) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`VerdictQueue: ${name} must be a positive number`);
      }
    }
    this.#journalFile = journalFile;
    this.#now = now;
    this.#leaseMs = leaseMs;
    this.#reofferDelayMs = reofferDelayMs;
    this.#verdictTtlMs = verdictTtlMs;
    this.#maxQueued = maxQueued;
    this.#compactAfter = compactAfter;
    this.#logger = logger;
  }

  // Replays the journal, then rewrites it from the live state so it starts
  // small. Throws if the journal cannot be read or written: a host end that
  // cannot keep its queue must not run, because it would answer asks it cannot
  // honour.
  open() {
    fs.mkdirSync(path.dirname(this.#journalFile), { recursive: true, mode: 0o700 });
    let skipped = 0;
    for (const line of readJournalLines(this.#journalFile)) {
      const record = parseRecord(line);
      if (record === null) {
        skipped += 1;
        continue;
      }
      if (record.t === RECORD_QUEUED) {
        if (!this.#items.has(record.h)) {
          this.#items.set(record.h, { queuedAt: record.at, notBefore: 0, batch: null });
        }
        this.#verdicts.delete(record.h);
      } else {
        this.#items.delete(record.h);
        const verdict = { classification: record.c, at: record.at };
        if (typeof record.m === 'string') verdict.matchType = record.m;
        this.#verdicts.set(record.h, verdict);
      }
    }
    if (skipped > 0) {
      this.#logger.error(`VerdictQueue: VERDICT_HOST_JOURNAL_SKIPPED_LINES count=${skipped}`);
    }
    this.#pruneVerdicts();
    this.#compact();
    return this;
  }

  close() {
    if (this.#fd !== null) {
      fs.closeSync(this.#fd);
      this.#fd = null;
    }
  }

  // The decorator asks about a hash. A recent verdict answers at once; else the
  // hash is queued (once) and the caller waits for the 'verdict' event.
  ask(hash) {
    const known = this.#verdicts.get(hash);
    if (known !== undefined) {
      if (this.#now() - known.at < this.#verdictTtlMs) {
        return { status: 'verdict', verdict: known };
      }
      this.#verdicts.delete(hash);
    }
    if (this.#items.has(hash)) return { status: 'queued' };
    if (this.#items.size >= this.#maxQueued) return { status: 'full' };
    const queuedAt = this.#now();
    try {
      this.#append({ t: RECORD_QUEUED, h: hash, at: queuedAt });
    } catch (err) {
      // A hash that is not on disk would be lost by a restart. Say so, and let
      // the decorator hold, rather than pretend it is queued.
      this.#logger.error(
        `VerdictQueue: VERDICT_HOST_JOURNAL_WRITE_FAILED code=${err.code ?? 'unknown'}`
      );
      return { status: 'error' };
    }
    this.#items.set(hash, { queuedAt, notBefore: 0, batch: null });
    this.emit('enqueued');
    return { status: 'queued' };
  }

  // Hands the safety service the hashes that are ready, up to the batch cap.
  lease(max = MAX_BATCH_HASHES) {
    const now = this.#now();
    this.#expireLeases(now);
    const hashes = [];
    for (const [hash, item] of this.#items) {
      if (hashes.length >= Math.min(max, MAX_BATCH_HASHES)) break;
      if (item.batch === null && item.notBefore <= now) hashes.push(hash);
    }
    if (hashes.length === 0) return null;
    const batch = crypto.randomBytes(16).toString('hex');
    this.#batches.set(batch, { hashes, expiresAt: now + this.#leaseMs });
    for (const hash of hashes) this.#items.get(hash).batch = batch;
    return { batch, hashes: [...hashes] };
  }

  // Takes the service's answers for one batch. `answers` maps a hash to
  // { classification, matchType? } for each hash with a definitive verdict.
  // A hash left out goes back to the queue, to be offered again after a pause.
  // Returns false when the host no longer holds that batch.
  settle(batch, answers) {
    const now = this.#now();
    this.#expireLeases(now);
    const leased = this.#batches.get(batch);
    if (leased === undefined) return false;
    this.#batches.delete(batch);
    for (const hash of leased.hashes) {
      const item = this.#items.get(hash);
      if (item === undefined) continue;
      const answer = answers.get(hash);
      if (answer === undefined) {
        item.batch = null;
        item.notBefore = now + this.#reofferDelayMs;
        continue;
      }
      this.#items.delete(hash);
      const verdict = { classification: answer.classification, at: now };
      if (typeof answer.matchType === 'string') verdict.matchType = answer.matchType;
      this.#verdicts.set(hash, verdict);
      try {
        this.#append({
          t: RECORD_VERDICT,
          h: hash,
          c: verdict.classification,
          m: verdict.matchType,
          at: now,
        });
      } catch (err) {
        // The verdict is a short memory; losing it re-asks the hash.
        this.#logger.error(
          `VerdictQueue: VERDICT_HOST_JOURNAL_WRITE_FAILED code=${err.code ?? 'unknown'}`
        );
      }
      this.emit('verdict', { hash, verdict });
    }
    return true;
  }

  // The hashes offered under a batch, or null once the lease has ended.
  batchHashes(batch) {
    const lease = this.#batches.get(batch);
    if (lease === undefined || lease.expiresAt <= this.#now()) return null;
    return [...lease.hashes];
  }

  // Seconds the oldest unverdicted hash has waited, leased or not; 0 when none.
  oldestAgeSeconds() {
    let oldest = null;
    for (const item of this.#items.values()) {
      if (oldest === null || item.queuedAt < oldest) oldest = item.queuedAt;
    }
    return oldest === null ? 0 : Math.max(0, (this.#now() - oldest) / 1000);
  }

  counts() {
    let leased = 0;
    for (const item of this.#items.values()) if (item.batch !== null) leased += 1;
    return { queued: this.#items.size - leased, leased, verdicts: this.#verdicts.size };
  }

  // Housekeeping a timer can call: ends expired leases, forgets old verdicts.
  sweep() {
    this.#expireLeases(this.#now());
    this.#pruneVerdicts();
  }

  #expireLeases(now) {
    for (const [batch, lease] of this.#batches) {
      if (lease.expiresAt > now) continue;
      this.#batches.delete(batch);
      for (const hash of lease.hashes) {
        const item = this.#items.get(hash);
        if (item !== undefined && item.batch === batch) {
          item.batch = null;
          item.notBefore = now + this.#reofferDelayMs;
        }
      }
    }
  }

  #pruneVerdicts() {
    const now = this.#now();
    for (const [hash, verdict] of this.#verdicts) {
      if (now - verdict.at >= this.#verdictTtlMs) this.#verdicts.delete(hash);
    }
  }

  #append(record) {
    if (this.#appends >= this.#compactAfter) this.#compact();
    const line = `${JSON.stringify(record)}\n`;
    fs.writeSync(this.#fd, line);
    fs.fsyncSync(this.#fd);
    this.#appends += 1;
  }

  // Writes the live state to a new file and renames it over the journal, so a
  // crash leaves either the old journal or the new one, never a mixture.
  #compact() {
    const temporary = `${this.#journalFile}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    const lines = [];
    for (const [hash, item] of this.#items) {
      lines.push(JSON.stringify({ t: RECORD_QUEUED, h: hash, at: item.queuedAt }));
    }
    for (const [hash, verdict] of this.#verdicts) {
      lines.push(
        JSON.stringify({
          t: RECORD_VERDICT,
          h: hash,
          c: verdict.classification,
          m: verdict.matchType,
          at: verdict.at,
        })
      );
    }
    const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600
    );
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, this.#journalFile);
    } catch (err) {
      fs.rmSync(temporary, { force: true });
      throw err;
    }
    if (this.#fd !== null) fs.closeSync(this.#fd);
    this.#fd = openJournal(this.#journalFile);
    this.#appends = 0;
  }
}

module.exports = {
  VerdictQueue,
  MAX_BATCH_HASHES,
  DEFAULT_LEASE_MS,
  DEFAULT_REOFFER_DELAY_MS,
  DEFAULT_VERDICT_TTL_MS,
  DEFAULT_MAX_QUEUED,
};
