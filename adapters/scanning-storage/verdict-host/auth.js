'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

// How the host end recognises the safety service: the platform broker's
// signed-request scheme, as the verdict channel contract restates it. The
// host holds only the public key. The check order is part of the control
// (verdict-host.md): format, replay window, signature, and only then the
// nonce claim, so an unsigned request cannot burn a signer's nonce.

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const NONCE_PATTERN = /^[A-Za-z0-9._-]{16,128}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,20}$/;
// Ahead of "now" by this much is clock drift; more is refused, because every
// second of forward slack is a second a captured request stays valid again.
const FORWARD_SKEW_SECONDS = 5;
const DEFAULT_REPLAY_WINDOW_SECONDS = 60;
const DEFAULT_MAX_NONCES = 100_000;
const MAX_KEY_FILE_BYTES = 128;

function publicKeyFromRaw(raw) {
  if (raw.length !== ED25519_KEY_BYTES) {
    throw new Error('Ed25519 public key must be 32 raw bytes');
  }
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

// The key file holds the base64 of 32 bytes and an optional final newline,
// which is the form the channel key role prints.
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
  return publicKeyFromRaw(raw);
}

function signingPayload(method, urlPath, timestamp, nonce, body) {
  return Buffer.concat([
    Buffer.from(`${method}\n${urlPath}\n${timestamp}\n${nonce}\n`, 'utf8'),
    body,
  ]);
}

function createNonceStore(windowMs, maxEntries = DEFAULT_MAX_NONCES) {
  const seen = new Map();
  return {
    claim(nonce, nowMs) {
      for (const [key, expiresAt] of seen) {
        if (expiresAt > nowMs) break;
        seen.delete(key);
      }
      if (seen.has(nonce) || seen.size >= maxEntries) return false;
      seen.set(nonce, nowMs + windowMs);
      return true;
    },
  };
}

// A spent nonce outlives the whole span in which its request would be admitted.
function nonceLifetimeMs(replayWindowSeconds) {
  return (replayWindowSeconds + FORWARD_SKEW_SECONDS + 1) * 1000;
}

function createAuthenticator({
  publicKey,
  replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
  now = Date.now,
  processStartSeconds = Math.floor(now() / 1000),
  nonces = createNonceStore(nonceLifetimeMs(replayWindowSeconds)),
}) {
  // Returns { ok: true } or { ok: false, reason } with a fixed reason string.
  return function verifyRequest(method, urlPath, headers, body) {
    const timestamp = headers['x-broker-timestamp'];
    const nonce = headers['x-broker-nonce'];
    const signature = headers['x-broker-signature'];
    if (typeof timestamp !== 'string' || !TIMESTAMP_PATTERN.test(timestamp)) {
      return { ok: false, reason: 'timestamp' };
    }
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
      return { ok: false, reason: 'nonce' };
    }
    if (typeof signature !== 'string' || signature === '') {
      return { ok: false, reason: 'signature-missing' };
    }
    const nowMs = now();
    const requestSeconds = Number(timestamp);
    const age = Math.floor(nowMs / 1000) - requestSeconds;
    if (age > replayWindowSeconds || age < -FORWARD_SKEW_SECONDS) {
      return { ok: false, reason: 'window' };
    }
    // `<=`: a request replayed after a restart inside the same second as the
    // start is refused too. A restart forgets every nonce, so the start time
    // is the floor.
    if (requestSeconds <= processStartSeconds) return { ok: false, reason: 'before-start' };

    const raw = Buffer.from(signature, 'base64');
    if (raw.length !== SIGNATURE_BYTES) return { ok: false, reason: 'signature' };
    let verified = false;
    try {
      verified = crypto.verify(
        null,
        signingPayload(method, urlPath, timestamp, nonce, body),
        publicKey,
        raw
      );
    } catch {
      verified = false;
    }
    if (!verified) return { ok: false, reason: 'signature' };
    if (!nonces.claim(nonce, nowMs)) return { ok: false, reason: 'replay' };
    return { ok: true };
  };
}

module.exports = {
  FORWARD_SKEW_SECONDS,
  DEFAULT_REPLAY_WINDOW_SECONDS,
  createAuthenticator,
  createNonceStore,
  loadVerifyKey,
  publicKeyFromRaw,
  signingPayload,
};
