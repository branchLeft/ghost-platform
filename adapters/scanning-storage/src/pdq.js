'use strict';

const crypto = require('node:crypto');

// A real perceptual hash proves near-duplicate matching, which is the
// verdict channel's job, not this decorator's -- this stand-in is
// deterministic and content-addressable, which is the only property this
// decorator itself depends on: the same bytes must always ask the verdict
// client the same question, and a refused digest must be usable as a
// quarantine filename.
function digestBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { digestBytes };
