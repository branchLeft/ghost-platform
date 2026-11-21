'use strict';

// Policy.decide(Verdict, Context) -> allow | refuse | hold | flag. 'flag'
// belongs to an advisory route this policy does not run and has no
// implementation anywhere in this decorator (src/hold.js handles 'hold';
// see its own module comment for why an in-process fake can still exercise
// the hold branch's asynchronous route with no real verdict channel).
const HOLD_OR_FLAG_NOT_IMPLEMENTED =
  "ScanningStorageAdapter: policy decision '%s' has no implementation in this decorator.";

// What a match does once it is made (policy.md). Two tiers, and only a
// tier-two match is irreversible:
//   'two'  exact + csam. Withhold, seal under the digest, start the clock.
//   'one'  near + csam, or any harmful-abusive-material. Withhold and freeze;
//          nobody has decided anything yet, so it can be undone.
// `test` is the control that proves the path without anyone holding anything,
// so it behaves as a match through the whole path, tier two included.
const TIER_ONE = 'one';
const TIER_TWO = 'two';

// Only the exact string 'exact' reaches tier two, and only with csam. A
// missing, unknown or differently-cased matchType, or a classification this
// code has never heard of, lands on tier one: a perceptual false positive
// must never reach an irreversible action, so every doubt rounds down.
function tierOf(verdict) {
  if (!verdict || verdict.classification === 'no-known-match') return null;
  if (verdict.classification === 'unavailable') return null;
  if (verdict.classification === 'test') return TIER_TWO;
  if (verdict.classification === 'csam' && verdict.matchType === 'exact') return TIER_TWO;
  return TIER_ONE;
}

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

  // The tier a refused verdict falls in, or null when it is not a match.
  // eslint-disable-next-line class-methods-use-this
  tier(verdict) {
    return tierOf(verdict);
  }
}

module.exports = { SafetyPolicy, HOLD_OR_FLAG_NOT_IMPLEMENTED, tierOf, TIER_ONE, TIER_TWO };
