'use strict';

// Why the host end's TLS identity was refused. `reason` is a fixed word a
// caller or test can branch on; the message names a file, never key material.
class TlsIdentityError extends Error {
  constructor(reason, message, options) {
    super(message, options);
    this.name = 'TlsIdentityError';
    this.code = 'TLS_IDENTITY_REFUSED';
    this.reason = reason;
  }
}

module.exports = { TlsIdentityError };
