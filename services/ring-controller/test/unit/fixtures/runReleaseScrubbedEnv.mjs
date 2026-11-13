// Standalone fixture, plain JS with no dependency on this package's build:
// runs the compiled `runRelease` in a real child process whose environment
// the parent test chose, with fake hosts and a fake clock, and prints one
// JSON line describing what happened.
//
//   argv[2]  directory holding the compiled src/ (the test transpiles it)
//   argv[3]  'green' or 'red': whether every gate passes
//
// It hands the child's own environment to `runRelease` as it stands; the
// parent decides what that holds.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [, , compiledDir, scenario] = process.argv;
const load = (name) => import(pathToFileURL(join(compiledDir, name)).href);
const { runRelease } = await load('ringController.js');
const { BumpStateMachine } = await load('bumpStateMachine.js');
const { createApplyLock } = await load('applyLock.js');

const digest = 'sha256:fixture-release';
const members = {
  'slot-0': [{ tenantId: 'canary', engine: 'mysql' }],
  demos: [],
  entry: [{ tenantId: 'entry-1', engine: 'sqlite' }],
  professional: [{ tenantId: 'pro-1', engine: 'sqlite' }],
};

let now = 0;
const seen = { gateRuns: 0, bumps: 0, holds: [] };
const lock = createApplyLock();
const ok = { ok: true };

const deps = {
  listMembers: async (ring) => members[ring],
  runGates: async (d) => {
    seen.gateRuns += 1;
    return { digest: d, results: [{ name: 'smoke', ok: scenario !== 'red' }] };
  },
  newBump: (member) => {
    seen.bumps += 1;
    return new BumpStateMachine(
      {
        backup: async () => ok,
        apply: async () => ok,
        awaitApplySettled: async () => ok,
        verify: async () => ok,
        revertTraffic: async () => ok,
        stopColour: async () => undefined,
        page: async () => undefined,
      },
      lock,
      { bumpId: `bump-${member.tenantId}` }
    );
  },
  health: async () => ({ healthy: true, reportedDigest: digest }),
  reportedErrors: async () => [],
  recordPromotion: async () => undefined,
  hold: async (held) => {
    seen.holds.push(held.reason);
  },
  clock: {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  },
};

const bake = { bakeMs: 1000, pollMs: 500 };
const config = { 'slot-0': bake, demos: bake, entry: bake, professional: bake };

try {
  const outcome = await runRelease(
    { digest, version: '9.9.9', route: 'fast-path' },
    deps,
    config,
    process.env
  );
  console.log(
    JSON.stringify({
      refused: false,
      outcome: outcome.status,
      reason: outcome.reason ?? null,
      ...seen,
    })
  );
} catch (err) {
  console.log(JSON.stringify({ refused: true, error: err.name, message: err.message, ...seen }));
}
