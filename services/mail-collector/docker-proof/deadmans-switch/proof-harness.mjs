// Drives the real, built createDeadMansSwitch (from the shared
// @branchleft/ghost-platform-deadmans-switch package) against a real local
// Healthchecks instance. Run from services/mail-collector/ after `pnpm run
// build`, with the healthchecks container already up. Never run against a
// production Healthchecks URL. See proof-harness.md#what-this-drives.
//
// Every status is asserted, so a wrong state exits non-zero rather than
// printing a line for a human to read.
import { createDeadMansSwitch } from '@branchleft/ghost-platform-deadmans-switch';

const BASE = process.env.PROOF_SITE_ROOT ?? 'http://localhost:8095';
const API_KEY = requireEnv('PROOF_API_KEY');
const IDLE_CODE = requireEnv('PROOF_IDLE_CHECK_CODE');
const STOPPED_CODE = requireEnv('PROOF_STOPPED_CHECK_CODE');

// The one drain target this proof's collector stands in for.
const TARGET = 'proof-worker';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`missing ${name}`);
  }
  return v;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkStatus(code) {
  const res = await fetch(`${BASE}/api/v3/checks/${code}`, {
    headers: { 'X-Api-Key': API_KEY },
  });
  if (!res.ok) {
    throw new Error(`status fetch failed: ${res.status}`);
  }
  const body = await res.json();
  return body.status;
}

function record(label, actual, expected) {
  return { label, actual, expected, ok: actual === expected };
}

const silentLog = { warn() {} };

function switchFor(code) {
  return createDeadMansSwitch({
    url: `${BASE}/ping/${code}`,
    log: silentLog,
    getExpectedTargetIds: () => [TARGET],
  });
}

async function idleAndRestartScenario() {
  const results = [];
  const switch_ = switchFor(IDLE_CODE);

  // CONTROL CASE: an idle worker -- only ever completing empty cycles,
  // never draining anything -- completes one cycle per 500ms tick for well
  // over three of the check's 3-second periods. It must stay "up" throughout.
  for (let i = 0; i < 22; i += 1) {
    switch_.onCycleComplete(TARGET);
    await sleep(500);
  }
  await sleep(500); // let the last ping land
  results.push(record('idle for >3 periods', await checkStatus(IDLE_CODE), 'up'));

  // RESTART CASE: a supervisor restart -- one missed window (the crash),
  // well inside the 3s timeout + 3s grace, then the cycle resumes. Must
  // never reach "down".
  await sleep(2000); // "crashed" -- nothing calls onCycleComplete()
  switch_.onCycleComplete(TARGET); // "restarted" -- the supervisor brought it back
  await sleep(500);
  results.push(
    record('killed once, restarted inside the grace window', await checkStatus(IDLE_CODE), 'up')
  );

  return results;
}

async function stoppedScenario() {
  const switch_ = switchFor(STOPPED_CODE);
  const results = [];

  switch_.onCycleComplete(TARGET);
  await sleep(300);
  results.push(record('just pinged', await checkStatus(STOPPED_CODE), 'up'));

  // STOPPED CASE: the worker is stopped and prevented from restarting --
  // nothing calls onCycleComplete() ever again. timeout=3s, grace=3s:
  // "up" until ~3s after the last ping, "grace" (Late) until ~6s, "down"
  // after that.
  await sleep(3500);
  results.push(
    record(
      '~3.8s after last ping (past timeout, inside grace)',
      await checkStatus(STOPPED_CODE),
      'grace'
    )
  );

  await sleep(3000);
  results.push(
    record('~6.8s after last ping (past timeout+grace)', await checkStatus(STOPPED_CODE), 'down')
  );

  return results;
}

const results = [...(await idleAndRestartScenario()), ...(await stoppedScenario())];

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.label}: ${r.actual} (expected ${r.expected})`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`${failed.length} of ${results.length} dead-man's-switch checks failed`);
  process.exit(1);
}
console.log(`all ${results.length} dead-man's-switch checks passed`);
