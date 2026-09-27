'use strict';

// Policy.decide(Verdict, Context) -> allow | refuse | hold | flag. Only allow
// and refuse are exercised here: an in-process verdict client never returns
// 'unavailable', so hold is never reached through it, and flag belongs to an
// advisory route this policy does not run. Both outcomes are still named, so
// a future caller cannot mistake their absence for a decision already made.
const HOLD_OR_FLAG_NOT_IMPLEMENTED =
  "ScanningStorageAdapter: policy decision '%s' has no implementation in this decorator.";

class SafetyPolicy {
  // eslint-disable-next-line class-methods-use-this
  decide(verdict) {
    if (!verdict || verdict.classification === 'no-known-match') {
      return 'allow';
    }
    if (verdict.classification === 'unavailable') {
      return 'hold';
    }
    return 'refuse';
  }
}

module.exports = { SafetyPolicy, HOLD_OR_FLAG_NOT_IMPLEMENTED };
