// Drives the real, built createDeadMansSwitch against a real local
// Healthchecks instance. Run from services/mail-collector/ after `npm run
// build`, with the healthchecks container already up. Never run against a
// production Healthchecks URL. See proof-harness.md#what-this-drives.
import { createDeadMansSwitch } from '../../dist/heartbeat.js';

const BASE = process.env.PROOF_SITE_ROOT ?? 'http://localhost:8095';
const API_KEY = requireEnv('PROOF_API_KEY');
const IDLE_CODE = requireEnv('PROOF_IDLE_CHECK_CODE');
const STOPPED_CODE = requireEnv('PROOF_STOPPED_CHECK_CODE');

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

const silentLog = { info() {}, warn() {} };

async function idleAndRestartScenario() {
  const results = [];
  const switch_ = createDeadMansSwitch({
    url: `${BASE}/ping/${IDLE_CODE}`,
    log: silentLog,
  });

  // CONTROL CASE: an idle worker -- only ever completing empty cycles,
  // never draining anything -- pings once per "poll cycle" (here, one
  // per 500ms tick) for well over three of the check's 3-second periods.
  // It must stay "up" throughout.
  for (let i = 0; i < 22; i += 1) {
    switch_.onCycleComplete();
    await sleep(500);
  }
  await sleep(500); // let the last ping land
  results.push(['idle for >3 periods', await checkStatus(IDLE_CODE)]);

  // RESTART CASE: simulate a supervisor restart -- one missed tick
  // (standing in for the crash-and-restart window), well inside the
  // 3s timeout + 3s grace = 6s before this check would go down, then
  // pinging resumes. Must never reach "down".
  await sleep(2000); // "crashed" -- nothing calls onCycleComplete()
  switch_.onCycleComplete(); // "restarted" -- the supervisor brought it back
  await sleep(500);
  results.push(['killed once, restarted inside the grace window', await checkStatus(IDLE_CODE)]);

  return results;
}

async function stoppedScenario() {
  const switch_ = createDeadMansSwitch({
    url: `${BASE}/ping/${STOPPED_CODE}`,
    log: silentLog,
  });
  const results = [];

  switch_.onCycleComplete();
  await sleep(300);
  results.push(['just pinged', await checkStatus(STOPPED_CODE)]);

  // STOPPED CASE: the worker is stopped and prevented from restarting --
  // nothing calls onCycleComplete() ever again. timeout=3s, grace=3s:
  // "up" until ~3s after the last ping, "grace" (Late) until ~6s, "down"
  // after that.
  await sleep(3500);
  results.push([
    '~3.8s after last ping (past timeout, inside grace)',
    await checkStatus(STOPPED_CODE),
  ]);

  await sleep(3000);
  results.push(['~6.8s after last ping (past timeout+grace)', await checkStatus(STOPPED_CODE)]);

  return results;
}

const idleResults = await idleAndRestartScenario();
const stoppedResults = await stoppedScenario();

for (const [label, status] of [...idleResults, ...stoppedResults]) {
  console.log(`${label}: ${status}`);
}
