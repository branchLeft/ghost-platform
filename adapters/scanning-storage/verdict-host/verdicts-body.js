'use strict';

const { isPdqKey } = require('../src/verdict-socket-frame');

// A strict reader of the body the safety service posts to
// POST /safety/v1/verdicts, written against the field sets in the channel
// contract. One entry that does not read, a field the version does not name,
// or a wrong version makes the whole body unreadable, and an unreadable body
// is no answer. See verdict-host.md for why this is a port and not an import.

const CHANNEL_VERSION = 1;
const BATCH_ID = /^[A-Za-z0-9._-]{16,128}$/;
const CLASSIFICATIONS = new Set([
  'csam',
  'harmful-abusive-material',
  'test',
  'no-known-match',
  'unavailable',
]);
const MATCH_TYPES = new Set(['exact', 'near']);
const HOLD_REASONS = new Set(['unavailable', 'context-rejected', 'audit-unavailable']);
const STEPS = new Set([
  'withhold',
  'freeze',
  'seal',
  'start-reporting-clock',
  'page',
  'kill-slot-quietly',
  'keep-site-serving',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnly(object, allowed) {
  return Object.keys(object).every((key) => allowed.includes(key));
}

function readDecision(value) {
  if (!isObject(value)) return null;
  if (value.action === 'allow') return hasOnly(value, ['action']) ? { action: 'allow' } : null;
  if (value.action === 'hold') {
    return hasOnly(value, ['action', 'reason']) && HOLD_REASONS.has(value.reason)
      ? { action: 'hold' }
      : null;
  }
  if (value.action !== 'refuse') return null;
  if (!hasOnly(value, ['action', 'tier', 'irreversible', 'control', 'steps'])) return null;
  if (value.tier !== 'one' && value.tier !== 'two') return null;
  if (typeof value.irreversible !== 'boolean' || typeof value.control !== 'boolean') return null;
  if (!Array.isArray(value.steps) || !value.steps.every((step) => STEPS.has(step))) return null;
  return { action: 'refuse' };
}

function readEntry(value) {
  if (!isObject(value)) return null;
  if (!hasOnly(value, ['hash', 'classification', 'matchType', 'source', 'decision', 'audited'])) {
    return null;
  }
  const decision = readDecision(value.decision);
  if (!isPdqKey(value.hash) || decision === null) return null;
  if (!CLASSIFICATIONS.has(value.classification)) return null;
  if (typeof value.source !== 'string' || value.source === '') return null;
  if (typeof value.audited !== 'boolean') return null;
  if (value.matchType !== undefined && !MATCH_TYPES.has(value.matchType)) return null;
  const entry = { hash: value.hash, classification: value.classification, decision };
  if (value.matchType !== undefined) entry.matchType = value.matchType;
  return entry;
}

// Returns { batch, entries } or null. `entries` carries only what the host
// acts on: the hash, the classification, the match type and the action.
function parseVerdictsBody(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(payload) || !hasOnly(payload, ['v', 'batch', 'verdicts'])) return null;
  if (payload.v !== CHANNEL_VERSION) return null;
  if (typeof payload.batch !== 'string' || !BATCH_ID.test(payload.batch)) return null;
  if (!Array.isArray(payload.verdicts)) return null;
  const entries = [];
  for (const raw of payload.verdicts) {
    const entry = readEntry(raw);
    if (entry === null) return null;
    entries.push(entry);
  }
  return { batch: payload.batch, entries };
}

// What a verdict is worth to the decorator. Only a definitive answer settles a
// hash: a "no known match" counts only when the service also allowed it, and
// a hold or an `unavailable` settles nothing, so the hash is offered again.
// A matched classification settles whatever the decision says, because the
// decorator's policy is the stricter reader of it.
function definitiveAnswers(body, offered) {
  const asked = new Set(offered);
  const answers = new Map();
  const named = new Set();
  for (const entry of body.entries) {
    if (!asked.has(entry.hash)) continue;
    // Two answers to one question settle neither.
    if (named.has(entry.hash)) {
      answers.delete(entry.hash);
      continue;
    }
    named.add(entry.hash);
    const clean = entry.classification === 'no-known-match';
    const matched =
      entry.classification === 'csam' ||
      entry.classification === 'harmful-abusive-material' ||
      entry.classification === 'test';
    if ((clean && entry.decision.action === 'allow') || matched) {
      const answer = { classification: entry.classification };
      if (entry.matchType !== undefined) answer.matchType = entry.matchType;
      answers.set(entry.hash, answer);
    }
  }
  return answers;
}

module.exports = {
  CHANNEL_VERSION,
  BATCH_ID,
  parseVerdictsBody,
  definitiveAnswers,
};
