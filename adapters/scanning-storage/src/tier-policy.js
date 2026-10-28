'use strict';

// The only value of `tier` that lets video and audio through. Any other
// value, including unset, empty, a different case, a stray space or a
// boolean, means "refuse", so a typo can only ever fail closed.
const PROFESSIONAL = 'professional';

// Decides, from boot config alone, whether this decorator instance accepts
// video and audio. Never inferred from limits, caps or hostnames, and never
// read from anything an uploader or a tenant can write. tier-policy.md says
// what accepting means and what it does not.
function resolveTierPolicy(config = {}) {
  return { allowVideoAudio: config?.tier === PROFESSIONAL };
}

module.exports = { PROFESSIONAL, resolveTierPolicy };
