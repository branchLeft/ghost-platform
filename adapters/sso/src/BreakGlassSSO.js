'use strict';

// Ghost loads this file by name from core/server/adapters/sso/ at boot. It must
// require nothing Ghost's own image does not already resolve from that
// directory: a module that fails to load stops Ghost starting.
const { SSOBase } = require('@tryghost/adapter-base-sso');
const { defineBreakGlassSSO } = require('./break-glass');

let logger;
try {
  logger = require('@tryghost/logging');
} catch {
  logger = undefined;
}

module.exports = defineBreakGlassSSO(SSOBase, { logger });
