'use strict';

const fs = require('node:fs');

// How the host end recognises the safety service: the platform broker's
// signed-request scheme, as the verdict channel contract restates it. The
// scheme is not written here. The broker's own check (services/broker/src/
// auth.ts), with its order, its nonce store and its Ed25519 key handling, is
// built into ./generated/signed-request.cjs by `pnpm run build:shared`, and
// this file only adapts it to the host: the key file, the replay-window
// default, the lower-case header names Node hands over, and the fixed reason
// each refusal is counted and logged under. The host holds only the public
// key. See services/broker/src/signedRequestScheme.md for why this is a build
// and not a port.
const {
  checkRequest,
  createInMemoryNonceStore,
  nonceLifetimeMs,
  publicKeyFromRaw,
} = require('./generated/signed-request.cjs');

const DEFAULT_REPLAY_WINDOW_SECONDS = 60;
const ED25519_KEY_BYTES = 32;
const MAX_KEY_FILE_BYTES = 128;

// The key file holds the base64 of 32 bytes and an optional final newline,
// which is the form the channel key role prints. Returns the raw 32 bytes,
// the form the broker's check takes.
function loadVerifyKey(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let text;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_KEY_FILE_BYTES) {
      throw new Error('the verify key file must be a small regular file');
    }
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  const value = text.endsWith('\n') ? text.slice(0, -1) : text;
  const raw = Buffer.from(value, 'base64');
  if (raw.length !== ED25519_KEY_BYTES || raw.toString('base64') !== value) {
    throw new Error('the verify key must be the canonical base64 of exactly 32 bytes');
  }
  publicKeyFromRaw(raw);
  return raw;
}

// A header that is not one string is no header: the broker's check treats an
// absent value as a malformed one.
function headerValue(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function createAuthenticator({
  publicKey,
  replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
  now = Date.now,
  processStartSeconds = Math.floor(now() / 1000),
  nonces = createInMemoryNonceStore(nonceLifetimeMs(replayWindowSeconds)),
}) {
  const deps = {
    verifyKey: publicKey,
    replayWindowSeconds,
    nonces,
    processStartSeconds,
    nowMs: now,
  };
  // Returns { ok: true } or { ok: false, reason } with a fixed reason string.
  return function verifyRequest(method, urlPath, headers, body) {
    const checked = checkRequest(
      deps,
      method,
      urlPath,
      {
        timestamp: headerValue(headers, 'x-broker-timestamp'),
        nonce: headerValue(headers, 'x-broker-nonce'),
        signature: headerValue(headers, 'x-broker-signature'),
      },
      body
    );
    return checked.ok ? { ok: true } : { ok: false, reason: checked.code };
  };
}

module.exports = {
  DEFAULT_REPLAY_WINDOW_SECONDS,
  createAuthenticator,
  createNonceStore: createInMemoryNonceStore,
  loadVerifyKey,
  publicKeyFromRaw,
};
