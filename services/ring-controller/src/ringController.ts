import type { BumpState, BumpStateMachine } from './bumpStateMachine.js';
import { assertGatesGreen, type GateReport } from './gates.js';
import { assertModelFreeEnvironment, type ModelFreeEnvironment } from './modelFreeEnvironment.js';
import {
  DEFAULT_POLL_MS,
  MYSQL_CANARY_RING,
  MYSQL_GATED_RING,
  RING_ORDER,
  validateBakeConfig,
  type RingBake,
  type RingBakeConfig,
  type RingName,
} from './rings.js';

export type ReleaseRoute = 'fast-path' | 'consent';

/** `route` is decided upstream (release classifier, major watcher); this module only honours it. */
export interface Release {
  digest: string;
  version: string;
  route: ReleaseRoute;
}

export interface RingMember {
  tenantId: string;
  engine: 'sqlite' | 'mysql';
}

export interface Health {
  healthy: boolean;
  /** The version read from the running instance, not from our own records. */
  reportedDigest?: string;
}

export type HoldReason =
  | 'consent-required'
  | 'restore-drill-unmet'
  | 'version-not-eligible'
  | 'gate-red'
  | 'gate-digest-mismatch'
  | 'bump-not-done'
  | 'unhealthy'
  | 'reported-error'
  | 'probe-failed'
  | 'no-mysql-in-ring-0';

/**
 * A hold keeps the release on the current version and is raised as an
 * operational alert and a filed work item. It is not a page.
 */
export interface Held {
  status: 'held';
  at: RingName | 'preflight' | 'gates';
  reason: HoldReason;
  tenantId?: string;
  detail?: string;
  digest: string;
  version: string;
}

export type ReleaseOutcome = { status: 'completed' } | Held;

export interface RingControllerDependencies {
  /** Ring 0 is the bumpable canaries; slot 0 itself is the gates' host. */
  listMembers(ring: RingName): Promise<readonly RingMember[]>;
  /** Run the gates once, on slot 0. */
  runGates(digest: string): Promise<GateReport>;
  /** Per-tenant wiring. Every machine it returns shares one `ApplyLock`. */
  newBump(member: RingMember, release: Release): BumpStateMachine;
  /** A throw or a timeout means unhealthy. */
  health(tenantId: string): Promise<Health>;
  /** A throw means blocked. */
  reportedErrors(tenantId: string, sinceMs: number): Promise<readonly string[]>;
  /** The operational alert and filed-work-item sink. Never a page, never an approval. */
  hold(held: Held): Promise<void>;
  clock: { now(): number; sleep(ms: number): Promise<void> };
}

interface Bumped {
  member: RingMember;
  machine: BumpStateMachine;
}

interface BumpOutcome {
  member: RingMember;
  machine: BumpStateMachine | undefined;
  state: BumpState | 'threw';
  detail?: string;
}

interface Problem {
  tenantId: string;
  machine: BumpStateMachine;
  reason: 'unhealthy' | 'reported-error' | 'probe-failed';
  detail: string;
}

type RingResult = { held: Held } | { held?: undefined; members: readonly RingMember[] };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Takes one already-published digest through the rings, in `RING_ORDER`,
 * one tenant at a time within a ring (LLD-4 §04/§06b). Deterministic code:
 * no model, no agent, no token budget (D37). `env` is passed in, never
 * read from the process, so a test can prove the controller promotes with
 * every key absent and refuses with one present. See README.md in this
 * directory for the narrative.
 */
export async function runRelease(
  release: Release,
  deps: RingControllerDependencies,
  config: RingBakeConfig,
  env: ModelFreeEnvironment
): Promise<ReleaseOutcome> {
  assertModelFreeEnvironment(env);
  validateBakeConfig(config);

  if (release.route !== 'fast-path') {
    return hold(deps, release, 'preflight', 'consent-required');
  }

  let report: GateReport;
  try {
    report = await deps.runGates(release.digest);
  } catch (err) {
    return hold(deps, release, 'gates', 'gate-red', {
      detail: `the gates did not run: ${messageOf(err)}`,
    });
  }
  const verdict = assertGatesGreen(report, release);
  if (!verdict.ok) {
    return hold(deps, release, 'gates', verdict.reason, { detail: verdict.detail });
  }

  let mysqlCanaryReady = false;
  for (const ring of RING_ORDER) {
    if (ring === MYSQL_GATED_RING && !mysqlCanaryReady) {
      return hold(deps, release, ring, 'no-mysql-in-ring-0', {
        detail: 'no MySQL canary in ring 0 is done and healthy',
      });
    }
    const result = await runRing(ring, release, deps, config[ring]);
    if (result.held) {
      return hold(deps, release, result.held.at, result.held.reason, result.held);
    }
    if (ring === MYSQL_CANARY_RING) {
      mysqlCanaryReady = result.members.some((member) => member.engine === 'mysql');
    }
  }
  return { status: 'completed' };
}

async function hold(
  deps: RingControllerDependencies,
  release: Release,
  at: Held['at'],
  reason: HoldReason,
  extra: { tenantId?: string; detail?: string } = {}
): Promise<Held> {
  const held: Held = {
    status: 'held',
    at,
    reason,
    digest: release.digest,
    version: release.version,
    ...(extra.tenantId === undefined ? {} : { tenantId: extra.tenantId }),
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
  };
  await deps.hold(held);
  return held;
}

async function runRing(
  ring: RingName,
  release: Release,
  deps: RingControllerDependencies,
  bake: RingBake
): Promise<RingResult> {
  const ringStartedAt = deps.clock.now();

  let members: readonly RingMember[];
  try {
    members = await deps.listMembers(ring);
  } catch (err) {
    return heldAt(ring, release, 'probe-failed', {
      detail: `listing members failed: ${messageOf(err)}`,
    });
  }

  const outcomes = await bumpInOrder(members, release, deps);
  const failed = outcomes.find((outcome) => outcome.state !== 'done');
  if (failed !== undefined) {
    return heldAt(ring, release, 'bump-not-done', {
      tenantId: failed.member.tenantId,
      detail: failed.detail ?? `bump ended in '${failed.state}'`,
    });
  }
  const bumped: Bumped[] = outcomes.flatMap((outcome) =>
    outcome.machine === undefined ? [] : [{ member: outcome.member, machine: outcome.machine }]
  );

  // The window opens when the ring's last member reaches done, so every
  // member soaks the full time. An empty ring opens it on entry.
  const bakeStartedAt = deps.clock.now();
  const regression = await soak(ring, bumped, release, deps, ringStartedAt, bakeStartedAt, bake);
  if (regression !== undefined) {
    return { held: regression };
  }

  for (const { member, machine } of bumped) {
    let state: BumpState;
    try {
      state = await machine.closeBakeWindow();
    } catch (err) {
      return heldAt(ring, release, 'bump-not-done', {
        tenantId: member.tenantId,
        detail: `closing the bake window failed: ${messageOf(err)}`,
      });
    }
    if (state !== 'closed') {
      return heldAt(ring, release, 'bump-not-done', {
        tenantId: member.tenantId,
        detail: `closing the bake window ended in '${state}'`,
      });
    }
  }
  return { members };
}

function heldAt(
  ring: RingName,
  release: Release,
  reason: HoldReason,
  extra: { tenantId?: string; detail?: string }
): { held: Held } {
  return {
    held: {
      status: 'held',
      at: ring,
      reason,
      digest: release.digest,
      version: release.version,
      ...extra,
    },
  };
}

/**
 * One member at a time, each awaited to a terminal state before the next
 * is even constructed. Stops at the first member that is not `done`; later
 * members are never touched, and nothing is undone fleet-wide.
 */
async function bumpInOrder(
  members: readonly RingMember[],
  release: Release,
  deps: RingControllerDependencies
): Promise<BumpOutcome[]> {
  const outcomes: BumpOutcome[] = [];
  for (const member of members) {
    const outcome = await bumpOne(member, release, deps);
    outcomes.push(outcome);
    if (outcome.state !== 'done') break;
  }
  return outcomes;
}

async function bumpOne(
  member: RingMember,
  release: Release,
  deps: RingControllerDependencies
): Promise<BumpOutcome> {
  try {
    const machine = deps.newBump(member, release);
    const state = await machine.run();
    return { member, machine, state };
  } catch (err) {
    return {
      member,
      machine: undefined,
      state: 'threw',
      detail: `the bump threw: ${messageOf(err)}`,
    };
  }
}

/**
 * Waits out the bake, reading every member's health and reported errors on
 * each pass, including a last pass at or after the window's end. The ring
 * advances only when that last pass finds nothing wrong. A regression
 * reverts the tenants that regressed, by their own flag change, and holds.
 */
async function soak(
  ring: RingName,
  bumped: readonly Bumped[],
  release: Release,
  deps: RingControllerDependencies,
  ringStartedAt: number,
  bakeStartedAt: number,
  bake: RingBake
): Promise<Held | undefined> {
  const endAt = bakeStartedAt + bake.bakeMs;
  const pollMs = bake.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    const problems = await probeRing(bumped, release, deps, ringStartedAt);
    if (problems.length > 0) {
      return regress(ring, problems, release);
    }
    const now = deps.clock.now();
    if (now >= endAt) {
      return undefined;
    }
    await deps.clock.sleep(Math.min(pollMs, endAt - now));
  }
}

/** Every member, every time: the first healthy tenant says nothing about the next. */
async function probeRing(
  bumped: readonly Bumped[],
  release: Release,
  deps: RingControllerDependencies,
  ringStartedAt: number
): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const { member, machine } of bumped) {
    const problem = await probeMember(member.tenantId, machine, release, deps, ringStartedAt);
    if (problem !== undefined) {
      problems.push(problem);
    }
  }
  return problems;
}

async function probeMember(
  tenantId: string,
  machine: BumpStateMachine,
  release: Release,
  deps: RingControllerDependencies,
  ringStartedAt: number
): Promise<Problem | undefined> {
  try {
    const health = await deps.health(tenantId);
    if (health.healthy !== true) {
      return { tenantId, machine, reason: 'unhealthy', detail: 'the instance reports unhealthy' };
    }
    if (health.reportedDigest !== release.digest) {
      return {
        tenantId,
        machine,
        reason: 'unhealthy',
        detail: 'the instance does not report the release digest',
      };
    }
  } catch (err) {
    return {
      tenantId,
      machine,
      reason: 'probe-failed',
      detail: `the health probe failed: ${messageOf(err)}`,
    };
  }
  try {
    const errors = await deps.reportedErrors(tenantId, ringStartedAt);
    if (errors.length > 0) {
      return {
        tenantId,
        machine,
        reason: 'reported-error',
        detail: `${errors.length} reported error(s) since the ring started`,
      };
    }
  } catch (err) {
    return {
      tenantId,
      machine,
      reason: 'probe-failed',
      detail: `the error probe failed: ${messageOf(err)}`,
    };
  }
  return undefined;
}

/**
 * Reverts, per tenant, each member that has affirmative evidence of a
 * regression, using the state machine's own post-done flag change. A probe
 * that merely failed is a block, not evidence: it reverts nothing. No old
 * colour was stopped, so every revert here is still only a flag change.
 */
async function regress(
  ring: RingName,
  problems: readonly Problem[],
  release: Release
): Promise<Held> {
  const notes: string[] = [];
  for (const problem of problems) {
    notes.push(`${problem.tenantId}: ${problem.detail}`);
    if (problem.reason === 'probe-failed') continue;
    try {
      const state = await problem.machine.abortAfterDone();
      notes.push(`${problem.tenantId}: reverted, now '${state}'`);
    } catch (err) {
      notes.push(`${problem.tenantId}: revert failed: ${messageOf(err)}`);
    }
  }
  const first = problems[0] as Problem;
  return {
    status: 'held',
    at: ring,
    reason: first.reason,
    tenantId: first.tenantId,
    detail: notes.join('; '),
    digest: release.digest,
    version: release.version,
  };
}
