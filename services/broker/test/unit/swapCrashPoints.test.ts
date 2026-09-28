import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailAddress, SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { descriptorHash } from '../../src/descriptorHash.js';
import { createDrainFlagStore } from '../../src/drainFlag.js';
import type { Colour } from '../../src/literals.js';
import { readSlotState, recoverCrashedSlots } from '../../src/stateStore.js';
import type { BrokerDeps } from '../../src/app.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';
import { demoDescriptor } from '../helpers/fixtures.js';

// A crash can land at any await in a swap. This drives real swaps through
// the HTTP entry point and, at every boundary of every injectable call,
// captures what a process killed there would leave on disk (the state
// file and both drain flags) plus which version each colour's container
// is running. Each capture is then fed to the real boot recovery, and the
// outcome is checked against what Caddy's `lb_policy first` would do with
// the recovered flags.

const SLOT = '0' as SlotName;
const APP_PORT_BASE = 9300;

interface Capture {
  readonly label: string;
  readonly stateText: string | null;
  readonly drained: Readonly<Record<Colour, boolean>>;
  readonly versions: Readonly<Partial<Record<Colour, string>>>;
}

function colourOfPort(port: number): Colour {
  return port === APP_PORT_BASE ? 'a' : 'b';
}

function recordingDeps(
  broker: () => TestBroker,
  captures: Capture[],
  recording: { on: boolean }
): (deps: BrokerDeps) => BrokerDeps {
  const versions: Partial<Record<Colour, string>> = {};
  let lastRendered: string | undefined;

  function capture(label: string): void {
    if (!recording.on) return;
    const b = broker();
    const statePath = join(b.stateDir, `${SLOT}.json`);
    captures.push({
      label,
      stateText: existsSync(statePath) ? readFileSync(statePath, 'utf8') : null,
      drained: {
        a: existsSync(join(b.drainFlagDir, `${SLOT}-a.drain`)),
        b: existsSync(join(b.drainFlagDir, `${SLOT}-b.drain`)),
      },
      versions: { ...versions },
    });
  }

  return (deps) => ({
    ...deps,
    drainFlags: {
      async set(slot, colour) {
        capture(`before set(${colour})`);
        await deps.drainFlags.set(slot, colour);
        capture(`after set(${colour})`);
      },
      async clear(slot, colour) {
        capture(`before clear(${colour})`);
        await deps.drainFlags.clear(slot, colour);
        capture(`after clear(${colour})`);
      },
      isSet: (slot, colour) => deps.drainFlags.isSet(slot, colour),
    },
    renderer: {
      async render(descriptor) {
        capture('before render');
        lastRendered = descriptorHash(descriptor);
        return deps.renderer.render(descriptor);
      },
    },
    wrapper: {
      ...deps.wrapper,
      async start(slot, colour) {
        capture(`before start(${colour})`);
        await deps.wrapper.start(slot, colour);
        versions[colour] = lastRendered;
        capture(`after start(${colour})`);
      },
    },
    adminApi: {
      async configure(baseUrl, descriptor) {
        capture('before configure');
        await deps.adminApi.configure(baseUrl, descriptor);
      },
    },
    ghostReadiness: {
      async isReady(port) {
        capture(`before isReady(${colourOfPort(port)})`);
        return deps.ghostReadiness.isReady(port);
      },
    },
  });
}

/** Replays one capture into fresh directories and runs the real boot recovery over it. */
async function recoverFrom(c: Capture): Promise<{
  readonly phase: string;
  readonly colour?: Colour;
  readonly descriptorHash?: string;
  readonly serving: Colour | null;
}> {
  const root = await makeTempDir('broker-crashpoint-');
  try {
    const stateDir = join(root, 'state');
    const flagDir = join(root, 'flags');
    await mkdir(stateDir);
    await mkdir(flagDir);
    if (c.stateText !== null) await writeFile(join(stateDir, `${SLOT}.json`), c.stateText);
    for (const colour of ['a', 'b'] as const) {
      if (c.drained[colour]) await writeFile(join(flagDir, `${SLOT}-${colour}.drain`), '');
    }
    const drainFlags = createDrainFlagStore(flagDir);
    await recoverCrashedSlots(
      stateDir,
      [SLOT],
      { slotsPath: join(root, 'slots.json'), leaseDir: root },
      () => undefined,
      {
        drainFlags,
        // Every colour that has ever been started answers 200: the worst
        // case, since a stale colour answering is what can be mistaken for
        // a rebuilt one.
        ghostReadiness: {
          isReady: async (port) => c.versions[colourOfPort(port)] !== undefined,
        },
        appPortBase: APP_PORT_BASE,
        readyPollTimeoutMs: 50,
      }
    );
    const state = await readSlotState(stateDir, SLOT);
    const aClear = !(await drainFlags.isSet(SLOT, 'a'));
    const bClear = !(await drainFlags.isSet(SLOT, 'b'));
    const serving: Colour | null = aClear ? 'a' : bClear ? 'b' : null;
    return {
      phase: state.phase,
      colour: state.colour,
      descriptorHash: state.descriptorHash,
      serving,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('a crash at every await of a colour swap, then boot recovery', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  async function capturesForSwap(deploysBefore: number): Promise<Capture[]> {
    const captures: Capture[] = [];
    const recording = { on: false };
    broker = await startTestBroker({
      wrapDeps: recordingDeps(() => broker!, captures, recording),
    });
    const version = (n: number) =>
      demoDescriptor({ ownerEmail: `v${n}@example.com` as EmailAddress });
    for (let n = 1; n <= deploysBefore; n++) {
      const res = await broker.signedFetch('POST', '/reconcile', {
        slot: SLOT,
        descriptor: version(n),
      });
      expect(res.status).toBe(200);
    }
    recording.on = true;
    const res = await broker.signedFetch('POST', '/reconcile', {
      slot: SLOT,
      descriptor: version(deploysBefore + 1),
    });
    expect(res.status).toBe(200);
    recording.on = false;
    return captures;
  }

  // v1 fresh into 'a', v2 into 'b', v3 into 'a' (leaving 'b' live, undrained
  // and running v2), then v4 into 'b': the sequence where the target is
  // stale and answering at the instant the swap starts.
  it.each([
    ['into the second-listed colour, with the target stale and undrained', 3, 'b'],
    ['into the first-listed colour', 2, 'a'],
  ] as const)(
    'swap %s: every crash point recovers to the colour Caddy serves, running the version the state records',
    async (_name, deploysBefore, target) => {
      const captures = await capturesForSwap(deploysBefore);

      // The window this test exists for must actually have been captured.
      const markerWindow = captures.filter((c) =>
        c.stateText?.includes(`"swapTarget":"${target}"`)
      );
      expect(markerWindow.length).toBeGreaterThan(3);

      const failures: string[] = [];
      for (const c of captures) {
        const r = await recoverFrom(c);
        const servedVersion = r.serving === null ? undefined : c.versions[r.serving];
        const ok =
          r.phase === 'running' &&
          r.serving !== null &&
          r.colour === r.serving &&
          servedVersion === r.descriptorHash;
        if (!ok) {
          failures.push(
            `${c.label}: phase=${r.phase} recorded=${r.colour} serving=${r.serving} ` +
              `servedVersionMatchesRecorded=${servedVersion === r.descriptorHash}`
          );
        }
      }
      expect(failures).toEqual([]);
    }
  );
});
