/**
 * The ring order is load-bearing; the bake times are not (LLD-4 §04/§06b).
 * Frozen and not configurable: nothing a caller passes can reorder it. See
 * README.md in this directory for the narrative.
 */
export const RING_ORDER = Object.freeze(['slot-0', 'demos', 'entry', 'professional'] as const);

export type RingName = (typeof RING_ORDER)[number];

/** The ring whose members are the canaries, one of which must be MySQL (U6). */
export const MYSQL_CANARY_RING: RingName = 'slot-0';

/** The first ring that may not be entered without a healthy MySQL canary in `MYSQL_CANARY_RING`. */
export const MYSQL_GATED_RING: RingName = 'entry';

export interface RingBake {
  /** How long a ring soaks after its last member reaches `done`. Required for every ring; zero is allowed. */
  readonly bakeMs: number;
  /** How often health and reported errors are re-read during the soak. Defaults to `DEFAULT_POLL_MS`. */
  readonly pollMs?: number;
}

export type RingBakeConfig = Readonly<Record<RingName, RingBake>>;

/** Incidental defaults (15/15/30/30 minutes): a caller supplies its own `RingBakeConfig`; none is assumed. */
export const DEFAULT_BAKE_MS: Readonly<Record<RingName, number>> = Object.freeze({
  'slot-0': 15 * 60 * 1000,
  demos: 15 * 60 * 1000,
  entry: 30 * 60 * 1000,
  professional: 30 * 60 * 1000,
});

export const DEFAULT_POLL_MS = 30 * 1000;

/**
 * Throws on a missing or nonsensical bake setting before anything is
 * touched, rather than discovering it mid-release.
 */
export function validateBakeConfig(config: RingBakeConfig): void {
  for (const ring of RING_ORDER) {
    const bake = config[ring] as RingBake | undefined;
    if (bake === undefined || !Number.isFinite(bake.bakeMs) || bake.bakeMs < 0) {
      throw new RangeError(`bake config for ring '${ring}' needs a finite bakeMs of zero or more`);
    }
    if (bake.pollMs !== undefined && !(Number.isFinite(bake.pollMs) && bake.pollMs > 0)) {
      throw new RangeError(`bake config for ring '${ring}' has a pollMs that is not above zero`);
    }
  }
}
