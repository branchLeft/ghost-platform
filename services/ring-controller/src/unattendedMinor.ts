import {
  decideUnattendedMinor,
  unattendedMinorEnabled,
  type MinorRefusal,
  type RestoreDrillRecord,
} from './minorEligibility.js';
import { assertModelFreeEnvironment, type ModelFreeEnvironment } from './modelFreeEnvironment.js';
import type { RingBakeConfig } from './rings.js';
import {
  runRelease,
  type Held,
  type HoldReason,
  type Release,
  type ReleaseOutcome,
  type RingControllerDependencies,
} from './ringController.js';

export interface UnattendedMinorRequest {
  release: Release;
  /** The version tenants run now, as a plain release tag. */
  currentVersion: string;
  /** The weekly restore drill's latest record; undefined when none is known. */
  restoreDrill: RestoreDrillRecord | undefined;
  maxDrillAgeMs?: number;
}

/** `declined` is the switched-off default: nothing ran and nothing is raised. */
export type UnattendedOutcome = ReleaseOutcome | { status: 'declined'; reason: 'flag-off' };

const HOLD_REASON: Readonly<Record<Exclude<MinorRefusal, 'flag-off'>, HoldReason>> = {
  major: 'consent-required',
  'consent-route': 'consent-required',
  'restore-drill-unmet': 'restore-drill-unmet',
  'version-unreadable': 'version-not-eligible',
  'not-an-upgrade': 'version-not-eligible',
};

/**
 * Decides first, then hands an eligible release to `runRelease` unchanged.
 * The flag is read from `env` and is off unless it is exactly `on`; while
 * off, nothing runs and nothing is raised. A refusal while it is on is a
 * hold, raised through the same sink as every other hold: tenants stay on
 * the current version and no person approves a way past it.
 */
export async function runUnattendedMinor(
  request: UnattendedMinorRequest,
  deps: RingControllerDependencies,
  config: RingBakeConfig,
  env: ModelFreeEnvironment
): Promise<UnattendedOutcome> {
  assertModelFreeEnvironment(env);
  const decision = decideUnattendedMinor({
    enabled: unattendedMinorEnabled(env),
    currentVersion: request.currentVersion,
    release: { version: request.release.version, route: request.release.route },
    restoreDrill: request.restoreDrill,
    nowMs: deps.clock.now(),
    ...(request.maxDrillAgeMs === undefined ? {} : { maxDrillAgeMs: request.maxDrillAgeMs }),
  });
  if (decision.eligible) {
    return runRelease(request.release, deps, config, env);
  }
  if (decision.reason === 'flag-off') {
    return { status: 'declined', reason: 'flag-off' };
  }
  const held: Held = {
    status: 'held',
    at: 'preflight',
    reason: HOLD_REASON[decision.reason],
    detail: decision.detail,
    digest: request.release.digest,
    version: request.release.version,
  };
  await deps.hold(held);
  return held;
}
