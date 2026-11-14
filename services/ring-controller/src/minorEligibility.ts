import type { ModelFreeEnvironment } from './modelFreeEnvironment.js';
import type { ReleaseRoute } from './ringController.js';

/** The environment variable that switches the unattended path on. Absent means off. */
export const UNATTENDED_MINOR_FLAG = 'RING_CONTROLLER_UNATTENDED_MINOR';

/** The one value that switches it on. Anything else, however close, is off. */
export const UNATTENDED_MINOR_ON = 'on';

/** Incidental: the drill runs weekly, so a pass older than eight days is not current. */
export const RESTORE_DRILL_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** What the weekly restore drill left behind. Reading it from its source is the caller's job. */
export interface RestoreDrillRecord {
  result: 'pass' | 'fail';
  finishedAtMs: number;
}

export interface MinorDecisionInput {
  enabled: boolean;
  /** The version tenants run now, as a plain release tag. */
  currentVersion: string;
  release: { version: string; route: ReleaseRoute };
  restoreDrill: RestoreDrillRecord | undefined;
  nowMs: number;
  /** Defaults to `RESTORE_DRILL_MAX_AGE_MS`. A value not above zero makes the drill unmet. */
  maxDrillAgeMs?: number;
}

export type MinorRefusal =
  | 'flag-off'
  | 'version-unreadable'
  | 'not-an-upgrade'
  | 'major'
  | 'consent-route'
  | 'restore-drill-unmet';

export type MinorDecision =
  | { eligible: true; kind: 'minor' | 'patch' }
  | { eligible: false; reason: MinorRefusal; detail: string };

interface Version {
  major: number;
  minor: number;
  patch: number;
}

const PLAIN_TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * A plain `X.Y.Z` tag, or undefined. A pre-release, a build suffix and a
 * number too large to compare exactly are all unreadable.
 */
function parseVersion(tag: string): Version | undefined {
  const match = PLAIN_TAG.exec(tag);
  if (match === null) {
    return undefined;
  }
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  return [major, minor, patch].every(Number.isSafeInteger) ? { major, minor, patch } : undefined;
}

/** Pure. On only for the exact word `on`; absent, empty or any other text is off. */
export function unattendedMinorEnabled(env: ModelFreeEnvironment): boolean {
  return env[UNATTENDED_MINOR_FLAG] === UNATTENDED_MINOR_ON;
}

/**
 * Pure. Met only by a passing record that finished no later than `nowMs` and
 * no longer ago than `maxAgeMs`. A missing, failed, future-dated or
 * non-finite record is unmet, and so is a maximum age that is not above zero.
 */
export function restoreDrillMet(
  drill: RestoreDrillRecord | undefined,
  nowMs: number,
  maxAgeMs: number = RESTORE_DRILL_MAX_AGE_MS
): boolean {
  if (drill === undefined || drill.result !== 'pass') {
    return false;
  }
  if (!(Number.isFinite(maxAgeMs) && maxAgeMs > 0)) {
    return false;
  }
  if (!Number.isFinite(drill.finishedAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  const age = nowMs - drill.finishedAtMs;
  return age >= 0 && age <= maxAgeMs;
}

const refuse = (reason: MinorRefusal, detail: string): MinorDecision => ({
  eligible: false,
  reason,
  detail,
});

/**
 * Pure. Decides whether a release may reach tenants with no person in the
 * loop: a minor or a patch of the running major, on the fast-path route,
 * with the flag on and a current passing restore drill. Everything else is
 * a refusal that leaves tenants where they are. It never enables anything:
 * `enabled` is the caller's reading of the flag, which is off by default.
 * See README.md in this directory for the narrative.
 */
export function decideUnattendedMinor(input: MinorDecisionInput): MinorDecision {
  if (!input.enabled) {
    return refuse('flag-off', 'the unattended path is switched off');
  }
  const current = parseVersion(input.currentVersion);
  const target = parseVersion(input.release.version);
  if (current === undefined || target === undefined) {
    return refuse('version-unreadable', 'a version is not a plain release tag');
  }
  if (target.major > current.major) {
    return refuse('major', 'a major version is never taken without the owner');
  }
  const isUpgrade =
    target.major === current.major &&
    (target.minor > current.minor ||
      (target.minor === current.minor && target.patch > current.patch));
  if (!isUpgrade) {
    return refuse('not-an-upgrade', 'the release is not newer than the running version');
  }
  if (input.release.route !== 'fast-path') {
    return refuse('consent-route', 'the release classifier routed it to the owner');
  }
  if (!restoreDrillMet(input.restoreDrill, input.nowMs, input.maxDrillAgeMs)) {
    return refuse('restore-drill-unmet', 'no current passing restore drill is on record');
  }
  return { eligible: true, kind: target.minor > current.minor ? 'minor' : 'patch' };
}
