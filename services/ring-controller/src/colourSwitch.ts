import type { BumpDependencies, StepResult } from './bumpStateMachine.js';

/** The two Ghost colours of one tenant. */
export type Colour = 'a' | 'b';

/**
 * What the host does for one tenant, one call at a time. Mode A
 * (branchLeft/workspace#3017): at most one Ghost process exists per tenant at
 * any instant. See README.md in this directory for the contract of each call.
 */
export interface ColourHost {
  /** Pull the image and check its migrations on a scratch copy. Starts no Ghost on the tenant's database. */
  prepare(colour: Colour, image: string): Promise<StepResult>;
  /** The colours whose Ghost process exists right now, starting, running or still stopping. Read from the host on every call. */
  runningColours(): Promise<readonly Colour[]>;
  /** Stop the colour's Ghost. Resolves only once the process has exited. */
  stop(colour: Colour): Promise<void>;
  /** Start the colour on the image from a document that carries it alone. Resolves once it is healthy. */
  start(colour: Colour, image: string): Promise<StepResult>;
}

export interface SwitchPlan {
  /** The colour running now. */
  from: Colour;
  /** The colour to bring up. */
  to: Colour;
  /** The image `to` runs. */
  image: string;
  /** The image `from` was running, put back if `to` does not come up. */
  restoreImage: string;
}

/** What is running after a switch, as read from the host; `'unknown'` when the host could not be read. */
export type RunningAfter = readonly Colour[] | 'unknown';

export type SwitchResult =
  | { ok: true; running: Colour }
  | { ok: false; reason: string; running: RunningAfter; restored: boolean };

function other(colour: Colour): Colour {
  return colour === 'a' ? 'b' : 'a';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readRunning(host: ColourHost): Promise<readonly Colour[] | undefined> {
  try {
    return await host.runningColours();
  } catch {
    return undefined;
  }
}

/**
 * Every start goes through here. It reads the host first and refuses while the
 * other colour has a process, whatever the caller's sequencing believes.
 */
async function guardedStart(host: ColourHost, colour: Colour, image: string): Promise<StepResult> {
  const up = await readRunning(host);
  if (up === undefined) {
    return { ok: false, reason: `cannot read which colour runs; ${colour} not started` };
  }
  if (up.some((running) => running !== colour)) {
    return { ok: false, reason: `${other(colour)} is running; ${colour} not started` };
  }
  try {
    return await host.start(colour, image);
  } catch (error) {
    return { ok: false, reason: `starting ${colour} threw: ${messageOf(error)}` };
  }
}

/** Stops the colour, then reads the host to confirm it has no process; a stop that threw but left no process counts. */
async function stopAndConfirm(host: ColourHost, colour: Colour): Promise<StepResult> {
  let thrown: string | undefined;
  try {
    await host.stop(colour);
  } catch (error) {
    thrown = messageOf(error);
  }
  const up = await readRunning(host);
  if (up === undefined) {
    return { ok: false, reason: `cannot confirm ${colour} exited${thrown ? `: ${thrown}` : ''}` };
  }
  if (up.includes(colour)) {
    return { ok: false, reason: `${colour} still has a process${thrown ? `: ${thrown}` : ''}` };
  }
  return { ok: true };
}

async function failed(host: ColourHost, reason: string, restored: boolean): Promise<SwitchResult> {
  return { ok: false, reason, running: (await readRunning(host)) ?? 'unknown', restored };
}

/**
 * The switch: stop `from` and wait for it to exit, confirm that on the host,
 * then start `to`. If `to` does not come up it is stopped and confirmed the
 * same way and `from` is started again on its old image. Rollback is this
 * function with the plan turned round; there is no other path. Safe to call
 * again after a crash: it starts from whatever the host reports.
 */
export async function switchColour(host: ColourHost, plan: SwitchPlan): Promise<SwitchResult> {
  const { from, to } = plan;
  if (from === to) return failed(host, `cannot switch ${from} to itself`, false);

  const before = await readRunning(host);
  if (before === undefined)
    return failed(host, 'cannot read which colour runs; nothing changed', false);
  if (before.length > 1) return failed(host, 'both colours are running; nothing changed', false);
  if (before[0] === to) return { ok: true, running: to };

  if (before[0] === from) {
    const stopped = await stopAndConfirm(host, from);
    if (!stopped.ok) {
      return failed(host, `${stopped.reason ?? 'stop failed'}; ${to} not started`, false);
    }
  }

  const started = await guardedStart(host, to, plan.image);
  if (started.ok) return { ok: true, running: to };

  const gone = await stopAndConfirm(host, to);
  if (!gone.ok) {
    return failed(host, `${started.reason ?? 'start failed'}; ${gone.reason ?? ''}`, false);
  }
  const restored = await guardedStart(host, from, plan.restoreImage);
  if (restored.ok) {
    return { ok: false, reason: started.reason ?? 'start failed', running: [from], restored: true };
  }
  return failed(
    host,
    `${started.reason ?? 'start failed'}; restoring ${from} failed: ${restored.reason ?? ''}`,
    false
  );
}

/**
 * Prepare while the old colour runs, then switch. Nothing is stopped until the
 * new image is on the host and its migrations have been checked.
 */
export async function applyColourSwitch(host: ColourHost, plan: SwitchPlan): Promise<StepResult> {
  let prepared: StepResult;
  try {
    prepared = await host.prepare(plan.to, plan.image);
  } catch (error) {
    prepared = { ok: false, reason: `prepare threw: ${messageOf(error)}` };
  }
  if (!prepared.ok) {
    return {
      ok: false,
      reason: `${plan.from} left running: ${prepared.reason ?? 'prepare failed'}`,
    };
  }
  const result = await switchColour(host, plan);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/** The same switch the other way, onto the image `from` ran before. */
export function rollbackColour(host: ColourHost, plan: SwitchPlan): Promise<SwitchResult> {
  return switchColour(host, {
    from: plan.to,
    to: plan.from,
    image: plan.restoreImage,
    restoreImage: plan.image,
  });
}

async function ensureStopped(host: ColourHost, colour: Colour): Promise<void> {
  const up = await readRunning(host);
  if (up === undefined) throw new Error(`cannot read which colour runs; ${colour} left as it is`);
  if (!up.includes(colour)) return;
  const stopped = await stopAndConfirm(host, colour);
  if (!stopped.ok) throw new Error(stopped.reason ?? `${colour} would not stop`);
}

/** The three `BumpDependencies` a Mode A tenant swaps in; `backup`, `verify` and `page` stay the caller's. */
export function colourSwitchDependencies(
  host: ColourHost,
  plan: SwitchPlan
): Pick<BumpDependencies, 'apply' | 'revertTraffic' | 'stopColour'> {
  return {
    apply: () => applyColourSwitch(host, plan),
    revertTraffic: async () => {
      const result = await rollbackColour(host, plan);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    stopColour: (which) => ensureStopped(host, which === 'new' ? plan.to : plan.from),
  };
}
