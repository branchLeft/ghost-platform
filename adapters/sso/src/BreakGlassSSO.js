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

// The one read this adapter makes of Ghost's own data: is the configured
// account active right now, by the same test Ghost's session lookup applies.
// Required lazily, at request time, so the boot path never loads the models.
async function isAccountActive(email, id) {
  const models = require('../../models');
  const user = await models.User.findOne({ id, email, status: 'active' });
  return Boolean(user);
}

module.exports = defineBreakGlassSSO(SSOBase, { logger, isAccountActive });
