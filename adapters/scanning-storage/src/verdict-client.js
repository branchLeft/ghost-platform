'use strict';

const path = require('node:path');
const fs = require('node:fs');

// An interface with an in-process fake standing in for the real channel --
// the safety service, its transport and its credential belong to a separate
// story and a separate repo; nothing here guesses that wire format. A
// VerdictClient answers one hash at a time, which is all a single save() or
// saveRaw() call ever needs; a batch-oriented real client can still
// implement this same method by resolving one hash out of its own batch.
class VerdictClient {
  // eslint-disable-next-line no-unused-vars
  async getVerdict(_digest) {
    throw new Error('VerdictClient.getVerdict is not implemented');
  }
}

// Classification vocabulary for the hash route: csam | harmful-abusive-
// material | test | no-known-match, plus 'unavailable' from the Check
// interface itself when no verdict could be reached.
//
// This fake is still in-process, but it can now simulate the channel D34's
// hold branch depends on: a digest named in `unavailable` answers
// 'unavailable' -- not by hanging (checks.js's own timeout already proves
// that race; duplicating it here would only make every test slower) --
// until it is told the real answer, in one of two ways. `deliverVerdict`
// resolves it in-process, for a unit test in the same process as the
// adapter. `resolvePath`, an optional directory, is for the image-test
// harness: a container and its test driver are two different processes, so
// the driver "delivers" a verdict by writing `<resolvePath>/<digest>.json`
// (via `docker exec`) and this client picks it up on its next poll --
// nothing about the real verdict channel's wire format is implied by a
// JSON file on disk, this is purely a test seam.
class FakeVerdictClient extends VerdictClient {
  constructor({
    refuse = new Map(),
    unavailable = [],
    resolvePath,
    source = 'fake-verdict-client',
  } = {}) {
    super();
    // digest -> {classification, matchType}
    this.refuse = refuse instanceof Map ? refuse : new Map(Object.entries(refuse));
    this.unavailable = new Set(unavailable);
    this.resolvePath = resolvePath || null;
    // digest -> {classification, matchType?}, settable in-process.
    this.resolved = new Map();
    this.source = source;
  }

  // Test-only escape hatch: makes a digest that was named `unavailable`
  // answer definitively on its next getVerdict() call, without a second
  // process or a file on disk. Never called from production code.
  deliverVerdict(digest, verdict) {
    this.resolved.set(digest, verdict);
  }

  async getVerdict(digest) {
    if (this.unavailable.has(digest) && !this.resolved.has(digest)) {
      const fromDisk = this.#readResolvedFile(digest);
      if (fromDisk) {
        return { ...fromDisk, source: this.source, evidence: digest };
      }
      return { classification: 'unavailable', source: this.source, evidence: digest };
    }

    if (this.resolved.has(digest)) {
      return { ...this.resolved.get(digest), source: this.source, evidence: digest };
    }

    const match = this.refuse.get(digest);
    if (match) {
      return {
        classification: match.classification,
        matchType: match.matchType,
        source: this.source,
        evidence: digest,
      };
    }
    return {
      classification: 'no-known-match',
      source: this.source,
      evidence: digest,
    };
  }

  // Synchronous and best-effort on purpose: a missing or malformed file
  // must read as "still unavailable", never throw and never crash a
  // held item's retry loop.
  #readResolvedFile(digest) {
    if (!this.resolvePath) return null;
    try {
      const raw = fs.readFileSync(path.join(this.resolvePath, `${digest}.json`), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

module.exports = { VerdictClient, FakeVerdictClient };
