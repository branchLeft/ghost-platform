// The spool releases mail to the gate through a rate limit. At the shim's
// default of 50 an hour, each message after the first waits 72 s, so the gate's
// messages miss its drain deadline. This checks the spool container's run args
// and the deadline in mail-gate.mjs as source text, so it needs no Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MESSAGES_BEFORE_PASS } from './mail-gate.mjs';

const source = readFileSync(fileURLToPath(new URL('./mail-gate.mjs', import.meta.url)), 'utf8');

const deadlineMatch = /const DRAIN_DEADLINE_MS = ([\d_]+);/.exec(source);
const runStart = source.indexOf("'run',");
const spoolImageAt = source.indexOf('spoolImage', runStart);
const spoolRunArgs = source.slice(runStart, spoolImageAt);
const rateMatch = /'-e',\s*'SHIM_MESSAGES_PER_HOUR=(\d+)'/.exec(spoolRunArgs);

test('the spool container sets a release rate that lets the gate messages out before the drain deadline', () => {
  assert.ok(
    runStart >= 0 && spoolImageAt > runStart,
    'the spool container run call must be present'
  );
  assert.ok(deadlineMatch, 'mail-gate.mjs must declare DRAIN_DEADLINE_MS as a numeric literal');
  assert.ok(
    rateMatch,
    "the spool container run args must set 'SHIM_MESSAGES_PER_HOUR=<n>' as separate '-e' and value arguments"
  );
  const drainDeadlineMs = Number(deadlineMatch[1].replace(/_/g, ''));
  const perHour = Number(rateMatch[1]);
  const lastReleaseMs = ((MESSAGES_BEFORE_PASS - 1) * 3_600_000) / perHour;
  assert.ok(
    lastReleaseMs <= drainDeadlineMs,
    `at ${perHour} messages an hour the last of ${MESSAGES_BEFORE_PASS} messages is released at ${Math.round(lastReleaseMs)} ms, past the ${drainDeadlineMs} ms drain deadline`
  );
});
