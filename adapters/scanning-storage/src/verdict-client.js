'use strict';

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
// interface itself when no verdict could be reached. This fake never
// returns 'unavailable': it is in-process and synchronous, so the
// timeout/no-channel hold path is not reachable through it, and this
// decorator does not implement that path.
class FakeVerdictClient extends VerdictClient {
  constructor({ refuse = new Map(), source = 'fake-verdict-client' } = {}) {
    super();
    // digest -> {classification, matchType}
    this.refuse = refuse instanceof Map ? refuse : new Map(Object.entries(refuse));
    this.source = source;
  }

  async getVerdict(digest) {
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
}

module.exports = { VerdictClient, FakeVerdictClient };
