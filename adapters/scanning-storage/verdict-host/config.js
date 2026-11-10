'use strict';

const net = require('node:net');
const path = require('node:path');

// The host end reads its settings from the environment, once, at start. A
// missing or malformed value is a start-time error that names the variable,
// never a default that guesses: an unconfigured host end must not run.

function requireAbsolutePath(env, name, suffix) {
  const value = env[name];
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  if (suffix !== undefined && !value.endsWith(suffix)) {
    throw new Error(`${name} must end in ${suffix}`);
  }
  return value;
}

function wholeNumber(env, name, fallback, { min = 1, max = 2 ** 31 - 1 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  }
  return Number(raw);
}

// Plain HTTP is served on a loopback address only. The safety service accepts
// plain http only for loopback and https for everything else, so anything
// reachable from another machine is TLS terminated in front of this process.
function isLoopback(host) {
  return net.isIPv4(host) ? host.startsWith('127.') : host === '::1';
}

function readConfig(env) {
  const inboundHost = env.VERDICT_HOST_INBOUND_HOST ?? '127.0.0.1';
  if (!isLoopback(inboundHost)) {
    throw new Error('VERDICT_HOST_INBOUND_HOST must be a loopback address');
  }
  const inboundPort = wholeNumber(env, 'VERDICT_HOST_INBOUND_PORT', undefined, { max: 65535 });
  if (inboundPort === undefined) throw new Error('VERDICT_HOST_INBOUND_PORT is required');
  const mode = env.VERDICT_HOST_SOCKET_MODE ?? '600';
  if (!/^[0-7]{3}$/.test(mode)) {
    throw new Error('VERDICT_HOST_SOCKET_MODE must be three octal digits');
  }
  return {
    socketPath: requireAbsolutePath(env, 'VERDICT_HOST_SOCKET'),
    socketMode: parseInt(mode, 8),
    journalFile: requireAbsolutePath(env, 'VERDICT_HOST_JOURNAL'),
    verifyKeyFile: requireAbsolutePath(env, 'VERDICT_HOST_VERIFY_KEY_FILE'),
    metricsFile: requireAbsolutePath(env, 'VERDICT_HOST_METRICS_FILE', '.prom'),
    inboundHost,
    inboundPort,
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
