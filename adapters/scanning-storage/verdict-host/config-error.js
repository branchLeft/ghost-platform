'use strict';

// A setting the host end refuses to start with. The message names the
// variable.
class VerdictHostConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerdictHostConfigError';
    this.code = 'VERDICT_HOST_CONFIG_INVALID';
  }
}

module.exports = { VerdictHostConfigError };
