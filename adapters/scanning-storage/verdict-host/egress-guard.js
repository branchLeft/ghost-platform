'use strict';

const dgram = require('node:dgram');
const dns = require('node:dns');
const net = require('node:net');

// Defence in depth for the host end's one hard property: it never dials out.
// The host end has no code that opens an outbound connection (a static test
// holds that), and this guard refuses one at the point Node makes it, in case
// a dependency or a later edit adds one. It is not a sandbox: code running in
// this process can undo it, so the load-bearing control is the unit's own
// network confinement. See verdict-host.md.

class EgressRefusedError extends Error {
  constructor(what) {
    super(`the verdict host end never dials out (refused ${what})`);
    this.name = 'EgressRefusedError';
    this.code = 'EGRESS_REFUSED';
  }
}

const NAME_PATTERN = /^(lookup|lookupService|resolve|reverse)/;

function resolverNames(target) {
  return Object.keys(target).filter(
    (name) => NAME_PATTERN.test(name) && typeof target[name] === 'function'
  );
}

function installNoEgress() {
  let refused = 0;
  const restores = [];

  // `allow` lets a call through to the original when it cannot leave the host.
  // Listening on an address makes Node look the address up, and an IP literal
  // resolves without any query, so only a literal is let through.
  const replace = (target, name, makeRefusal, allow = () => false) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function refusedDial(...args) {
      if (allow(args)) return original.apply(this, args);
      refused += 1;
      return makeRefusal(`${name}`);
    };
    restores.push(() => {
      target[name] = original;
    });
  };
  const throwing = (what) => {
    throw new EgressRefusedError(what);
  };
  const rejecting = (what) => Promise.reject(new EgressRefusedError(what));

  // net.connect, http.request, fetch and tls.connect all reach a socket's
  // connect(): one patch covers them. An accepted connection never calls it.
  replace(net.Socket.prototype, 'connect', throwing);
  replace(dgram.Socket.prototype, 'send', throwing);
  replace(dgram.Socket.prototype, 'connect', throwing);
  const isLiteral = ([host]) => typeof host === 'string' && net.isIP(host) !== 0;
  for (const name of resolverNames(dns)) {
    replace(dns, name, throwing, name === 'lookup' ? isLiteral : undefined);
  }
  for (const name of resolverNames(dns.promises)) {
    replace(dns.promises, name, rejecting, name === 'lookup' ? isLiteral : undefined);
  }
  for (const name of resolverNames(dns.Resolver.prototype)) {
    replace(dns.Resolver.prototype, name, throwing);
  }

  return {
    refusedCount: () => refused,
    uninstall() {
      while (restores.length > 0) restores.pop()();
    },
  };
}

module.exports = { installNoEgress, EgressRefusedError };
