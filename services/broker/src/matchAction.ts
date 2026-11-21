/**
 * What a match does once it is made, as the control plane carries it out
 * (LLD-7 section 06). Two tiers, and only a tier-two match is irreversible:
 * exact + csam is sealed and, on a demo, kills the slot; every other match is
 * a freeze, the same on a demo and on a tenant, which nobody has decided
 * anything about yet. The host-side half (withholding and sealing every copy
 * under its digest) is the scanning adapter's and is `policy.js`'s mirror:
 * `matchAction.test.ts` holds the two to one table. See matchAction.md.
 */
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import type { DemoBroker, FreezeReply, ResetReply } from './controlPlaneDemoBroker.js';

export type MatchTier = 'one' | 'two';

/** The two fields of a verdict the tier turns on; the rest of it is nobody's here. */
export interface MatchVerdict {
  readonly classification: string;
  readonly matchType?: string | null | undefined;
}

/** Where the matching upload lives: a demo is a slot that can be killed; a tenant is never taken down for one upload. */
export type Estate =
  { readonly kind: 'demo'; readonly slot: SlotName } | { readonly kind: 'tenant' };

/**
 * The tier of a verdict, or undefined when it is not a match. Only the exact
 * string `exact` reaches tier two, and only with csam; `test` is the control
 * that proves the whole path without anyone holding anything, so it behaves as
 * a match through all of it. Every doubt (no matchType, a different case, a
 * classification this code has never heard of) is tier one, because a
 * perceptual false positive must never reach an irreversible action.
 */
export function tierOf(verdict: MatchVerdict | undefined): MatchTier | undefined {
  if (verdict === undefined) return undefined;
  const { classification, matchType } = verdict;
  if (classification === 'no-known-match' || classification === 'unavailable') return undefined;
  if (classification === 'test') return 'two';
  if (classification === 'csam' && matchType === 'exact') return 'two';
  return 'one';
}

/**
 * What a match does, as facts a test can read. `withhold` is always true: a
 * match is never served. The rest is what the tier adds.
 */
export interface MatchPlan {
  readonly tier: MatchTier;
  readonly withhold: true;
  /** Keep every copy under its digest, where nothing removes it. Tier two only. */
  readonly seal: boolean;
  /** Start the reporting clock (the alarm is another story). Tier two only. */
  readonly startReportingClock: boolean;
  /** Freeze: the reversible hold, reviewed from digests and verdicts alone. Tier one only. */
  readonly freeze: boolean;
  /** Detach the slot's evidence, then reset it. Tier two on a demo, and nothing else. */
  readonly killSlot: boolean;
}

export function planMatch(
  verdict: MatchVerdict | undefined,
  estate: Estate
): MatchPlan | undefined {
  const tier = tierOf(verdict);
  if (tier === undefined) return undefined;
  const two = tier === 'two';
  return {
    tier,
    withhold: true,
    seal: two,
    startReportingClock: two,
    freeze: !two,
    killSlot: two && estate.kind === 'demo',
  };
}

/** How the kill ended. Only `killed` and `already-free` leave the slot gone. */
export type KillResult =
  | { readonly kind: 'killed' }
  /** The broker said the slot was free and held nothing to freeze: there was nothing to kill. */
  | { readonly kind: 'already-free' }
  /** The evidence was not confirmed detached, so no reset was sent. The slot is left as it is; page. */
  | { readonly kind: 'evidence-not-detached'; readonly last: FreezeReply }
  /** The evidence is safe and the slot is still up; the reset did not complete. Retry it. */
  | { readonly kind: 'reset-failed'; readonly last: ResetReply };

export interface KillOptions {
  /** How many times each call is sent while the broker says retry. Default 5. */
  readonly attempts?: number;
  /** Waits between sends; a test passes an immediate one. Default 2 seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly delayMs?: number;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 2000;

/**
 * Kills a demo slot quietly: the evidence leaves by detaching first, and the
 * reset is sent only on the broker's confirmed `detached`, never on silence,
 * a retry-later or a guess. The tenancy goes, the evidence does not. Nothing
 * here says why to anyone: the result is a closed set, never a message.
 */
export async function killDemoSlot(
  broker: DemoBroker,
  slot: SlotName,
  options: KillOptions = {}
): Promise<KillResult> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let frozen: FreezeReply = 'unanswered';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    frozen = await broker.freeze(slot);
    if (frozen === 'detached' || frozen === 'nothing-to-freeze' || frozen === 'refused') break;
  }
  if (frozen === 'nothing-to-freeze') return { kind: 'already-free' };
  if (frozen !== 'detached') return { kind: 'evidence-not-detached', last: frozen };

  let reset: ResetReply = 'unanswered';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    reset = await broker.reset(slot);
    if (reset === 'free' || reset === 'refused') break;
  }
  return reset === 'free' ? { kind: 'killed' } : { kind: 'reset-failed', last: reset };
}

export interface MatchOutcome {
  readonly plan: MatchPlan;
  /** Present only when the plan kills the slot. */
  readonly kill?: KillResult;
}

/**
 * Carries out the control plane's half of a match. Returns undefined for a
 * verdict that is not a match. A tier-one match and a tier-two match on a
 * tenant send nothing to any broker: the site keeps serving, and what was
 * withheld was withheld on the host.
 */
export async function actOnMatch(
  verdict: MatchVerdict | undefined,
  estate: Estate,
  broker: DemoBroker,
  options: KillOptions = {}
): Promise<MatchOutcome | undefined> {
  const plan = planMatch(verdict, estate);
  if (plan === undefined) return undefined;
  if (plan.killSlot && estate.kind === 'demo') {
    return { plan, kill: await killDemoSlot(broker, estate.slot, options) };
  }
  return { plan };
}
