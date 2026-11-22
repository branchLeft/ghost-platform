// The vocabulary every other module shares: the cases, what a verdict is, and
// the shape of a run's result file, which the report generator reads and
// nothing else.

export const CASE_IDS = [
  'uploaded-script',
  'inline-script',
  'cookie-tossing',
  'portal-host-cookies',
  'cookie-bomb',
  'cross-site-request',
  'theme-script',
] as const;

export type CaseId = (typeof CASE_IDS)[number];

/**
 * `held`: the attack was exercised and the control stopped it.
 * `breached`: the attack was exercised and got through.
 * `not-exercised`: the attack never reached the control (an upload Ghost
 * refused before the edge saw it, a page that did not load). Never a pass: an
 * attack that was not run proves nothing.
 */
export type Verdict = 'held' | 'breached' | 'not-exercised';

/**
 * What the suite measured beyond the verdict: the harm the browser itself would
 * allow if a script did run, which only the Public Suffix List entry removes.
 * `accepted-risk` means the entry is not yet in place and the owner has accepted
 * that leftover risk on the one condition that no tenant script runs on the
 * shared domain; it is reported, never silently counted as a pass.
 */
export type ResidualStatus = 'held' | 'breached' | 'accepted-risk' | 'not-measured';

export interface Residual {
  readonly status: ResidualStatus;
  readonly detail: string;
}

export type VectorOutcome = 'blocked' | 'ran' | 'not-exercised';

export interface VectorResult {
  readonly vector: string;
  readonly outcome: VectorOutcome;
  readonly evidence: string;
}

export interface Judgement {
  readonly verdict: Verdict;
  readonly summary: string;
  readonly vectors: readonly VectorResult[];
  readonly residual?: Residual;
}

/** A control turned off on purpose, to show the case goes red without it. */
export interface SabotageResult {
  readonly mode: SabotageMode;
  readonly verdict: Verdict;
  /** True when the case went red (breached), which is what the sabotage must do. */
  readonly wentRed: boolean;
  readonly summary: string;
}

export const SABOTAGE_MODES = [
  'no-upload-guard',
  'no-csp',
  'origin-spoof',
  'portal-prefix-off',
] as const;
export type SabotageMode = (typeof SABOTAGE_MODES)[number];

export interface CaseResult extends Judgement {
  readonly id: CaseId;
  readonly title: string;
  readonly control: string;
  readonly sabotage: SabotageResult | null;
}

export interface ImageRecord {
  readonly role: string;
  readonly reference: string;
  /** The image's own content id (`sha256:<64 hex>`), always present for a local image. */
  readonly imageId: string | null;
  /** Registry digests (`name@sha256:<64 hex>`); empty for an image built locally. */
  readonly repoDigests: readonly string[];
  /**
   * `inspected`: read from the Docker daemon by this run. `pinned`: the base
   * image a Dockerfile in this checkout pins by digest. `supplied`: given by the operator.
   */
  readonly source: 'inspected' | 'pinned' | 'supplied';
}

export type PslState = 'absent' | 'present';

export interface TargetRecord {
  readonly kind: 'local-rig' | 'deployed';
  /** The shared tenant domain the two tenants sit under, without a scheme. */
  readonly sharedDomain: string;
  /** The registrable domain above it, which the portal sits under. */
  readonly rootDomain: string;
  readonly tenantHosts: readonly [string, string];
  readonly portalHost: string;
  readonly psl: PslState;
}

export interface RunResult {
  readonly schema: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly target: TargetRecord;
  readonly images: readonly ImageRecord[];
  readonly browser: { readonly name: string; readonly version: string };
  /** The commit of this repository the suite ran from, or null when it could not be read. */
  readonly revision: string | null;
  readonly cases: readonly CaseResult[];
}

export function isHeld(result: CaseResult): boolean {
  return result.verdict === 'held';
}
