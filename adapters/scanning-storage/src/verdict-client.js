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

// The name a delivered verdict's file carries for a key. A perceptual hash
// is base64, which has `/` in its alphabet, so the key is mapped to the
// URL-safe alphabet without padding; a key made of hex digits is unchanged.
function resolveFileStem(key) {
  return String(key).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Simulates the channel the hold branch depends on: a digest named in
// `unavailable` answers 'unavailable' until resolved, either in-process
// (`deliverVerdict`) or via `resolvePath`, a test seam for the image-test
// harness. See verdict-client.md#fakeverdictclient.
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
      const raw = fs.readFileSync(
        path.join(this.resolvePath, `${resolveFileStem(digest)}.json`),
        'utf8'
      );
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

// What stands in for the channel when none is configured. It never answers
// 'no-known-match': a verdict source that cannot scan has no business
// vouching for anything. 'unavailable' keeps an already-held digest held,
// and the decorator itself refuses new uploads while this is its only
// source (see verdict-source.md).
class UnconfiguredVerdictClient extends VerdictClient {
  constructor({ source = 'unconfigured-verdict-source' } = {}) {
    super();
    this.source = source;
  }

  async getVerdict(digest) {
    return { classification: 'unavailable', source: this.source, evidence: digest };
  }
}

module.exports = {
  VerdictClient,
  FakeVerdictClient,
  UnconfiguredVerdictClient,
  resolveFileStem,
};
