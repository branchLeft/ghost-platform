'use strict';

// Policy.decide(Verdict, Context) -> allow | refuse | hold | flag. 'flag'
// belongs to an advisory route this policy does not run and has no
// implementation anywhere in this decorator (src/hold.js handles 'hold';
// see its own module comment for why an in-process fake can still exercise
// D34's asynchronous branch with no real verdict channel).
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
