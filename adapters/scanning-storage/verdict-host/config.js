'use strict';

const net = require('node:net');
const path = require('node:path');
const { VerdictHostConfigError } = require('./config-error');

// The host end reads its settings from the environment, once, at start. A
// missing or malformed value is a start-time error that names the variable,
// never a default that guesses: an unconfigured host end must not run.

function requireAbsolutePath(env, name, suffix) {
  const value = env[name];
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new VerdictHostConfigError(`${name} must be an absolute path`);
  }
  if (suffix !== undefined && !value.endsWith(suffix)) {
    throw new VerdictHostConfigError(`${name} must end in ${suffix}`);
  }
  return value;
}

function wholeNumber(env, name, fallback, { min = 1, max = 2 ** 31 - 1 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new VerdictHostConfigError(`${name} must be a whole number between ${min} and ${max}`);
  }
  return Number(raw);
}

const TLS_MODE_PINNED_PRIVATE = 'pinned-private';

// Plain HTTP is served on a loopback address only: the safety service accepts
// plain http for loopback and nothing else.
function isLoopback(host) {
  return net.isIPv4(host) ? host.startsWith('127.') : host === '::1';
}

function isPrivateIPv4(host) {
  if (!net.isIPv4(host)) return false;
  const [first, second] = host.split('.').map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

// IPv6 unique-local addresses (fc00::/7). The WHATWG URL parser both rejects a
// malformed literal and writes a valid one in one canonical form, so the first
// group of a unique-local address is always four hex digits, fc00 to fdff.
function isUniqueLocalIPv6(host) {
  if (!/^[0-9a-fA-F:.]*:[0-9a-fA-F:.]*$/.test(host)) return false;
  let canonical;
  try {
    canonical = new URL(`http://[${host}]/`).hostname;
  } catch {
    return false;
  }
  return /^\[f[cd][0-9a-f]{2}:/.test(canonical);
}

// With TLS the listener may sit on a private address as well, never on a
// wildcard or a public one: the host end has no public name and no public
// listener.
function isLoopbackOrPrivate(host) {
  return isLoopback(host) || isPrivateIPv4(host) || isUniqueLocalIPv6(host);
}

function readTlsSettings(env) {
  const mode = env.VERDICT_HOST_INBOUND_TLS;
  if (mode !== undefined && mode !== TLS_MODE_PINNED_PRIVATE) {
    throw new VerdictHostConfigError(
      `VERDICT_HOST_INBOUND_TLS must be ${TLS_MODE_PINNED_PRIVATE} when set`
    );
  }
  const hasCertificate = env.VERDICT_HOST_TLS_CERT_FILE !== undefined;
  const hasKey = env.VERDICT_HOST_TLS_KEY_FILE !== undefined;
  if (hasCertificate !== hasKey) {
    const missing = hasCertificate ? 'VERDICT_HOST_TLS_KEY_FILE' : 'VERDICT_HOST_TLS_CERT_FILE';
    throw new VerdictHostConfigError(
      `${missing} is required: the TLS certificate and key files are set together`
    );
  }
  if (mode !== undefined && !hasCertificate) {
    throw new VerdictHostConfigError(
      'VERDICT_HOST_TLS_CERT_FILE and VERDICT_HOST_TLS_KEY_FILE are required when VERDICT_HOST_INBOUND_TLS is set'
    );
  }
  if (!hasCertificate) return { tlsCertFile: undefined, tlsKeyFile: undefined };
  return {
    tlsCertFile: requireAbsolutePath(env, 'VERDICT_HOST_TLS_CERT_FILE'),
    tlsKeyFile: requireAbsolutePath(env, 'VERDICT_HOST_TLS_KEY_FILE'),
  };
}

function readInboundHost(env, isTlsOn) {
  const inboundHost = env.VERDICT_HOST_INBOUND_HOST ?? '127.0.0.1';
  if (!isTlsOn && !isLoopback(inboundHost)) {
    throw new VerdictHostConfigError('VERDICT_HOST_INBOUND_HOST must be a loopback address');
  }
  if (isTlsOn && !isLoopbackOrPrivate(inboundHost)) {
    throw new VerdictHostConfigError(
      'VERDICT_HOST_INBOUND_HOST must be a loopback or private IP address when TLS is configured (not a wildcard or public address)'
    );
  }
  return inboundHost;
}

function readConfig(env) {
  const tls = readTlsSettings(env);
  const inboundHost = readInboundHost(env, tls.tlsCertFile !== undefined);
  const inboundPort = wholeNumber(env, 'VERDICT_HOST_INBOUND_PORT', undefined, { max: 65535 });
  if (inboundPort === undefined) {
    throw new VerdictHostConfigError('VERDICT_HOST_INBOUND_PORT is required');
  }
  const mode = env.VERDICT_HOST_SOCKET_MODE ?? '600';
  if (!/^[0-7]{3}$/.test(mode)) {
    throw new VerdictHostConfigError('VERDICT_HOST_SOCKET_MODE must be three octal digits');
  }
  return {
    socketPath: requireAbsolutePath(env, 'VERDICT_HOST_SOCKET'),
    socketMode: parseInt(mode, 8),
    journalFile: requireAbsolutePath(env, 'VERDICT_HOST_JOURNAL'),
    verifyKeyFile: requireAbsolutePath(env, 'VERDICT_HOST_VERIFY_KEY_FILE'),
    metricsFile: requireAbsolutePath(env, 'VERDICT_HOST_METRICS_FILE', '.prom'),
    inboundHost,
    inboundPort,
    ...tls,
    holdMs: wholeNumber(env, 'VERDICT_HOST_HOLD_MS', 30_000),
    leaseMs: wholeNumber(env, 'VERDICT_HOST_LEASE_MS', 120_000),
    reofferDelayMs: wholeNumber(env, 'VERDICT_HOST_REOFFER_DELAY_MS', 30_000),
    verdictTtlMs: wholeNumber(env, 'VERDICT_HOST_VERDICT_TTL_MS', 600_000),
    askWaitMs: wholeNumber(env, 'VERDICT_HOST_ASK_WAIT_MS', 1000),
    maxQueued: wholeNumber(env, 'VERDICT_HOST_MAX_QUEUED', 10_000),
    replayWindowSeconds: wholeNumber(env, 'VERDICT_HOST_REPLAY_WINDOW_SECONDS', 60, { max: 3600 }),
  };
}

module.exports = { readConfig };
