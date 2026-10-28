/** The states a demo moves through. The names are identifiers; the design is the demo lifecycle document. */
export const DEMO_STATES = [
  'VERIFIED',
  'WAITING',
  'CLAIMED',
  'PROVISIONING',
  'LIVE',
  'EXTENDED',
  'EXPIRING',
  'REBUILDING',
  'PROMOTING',
  'PROMOTED',
  'FAILED',
  'KILLED',
  'FROZEN',
  'PURGED',
] as const;
export type DemoState = (typeof DEMO_STATES)[number];

/** The states that hold a slot: the two safety exits (kill, freeze) leave any of them. */
export const SLOT_HOLDING_STATES: readonly DemoState[] = [
  'CLAIMED',
  'PROVISIONING',
  'LIVE',
  'EXTENDED',
  'EXPIRING',
  'REBUILDING',
  'PROMOTING',
];

const SAFETY_EXITS: readonly DemoState[] = ['KILLED', 'FROZEN'];

const EXITS: Record<DemoState, readonly DemoState[]> = {
  VERIFIED: ['CLAIMED', 'WAITING'],
  WAITING: ['CLAIMED'],
  CLAIMED: ['PROVISIONING', 'WAITING'],
  PROVISIONING: ['LIVE', 'FAILED'],
  LIVE: ['EXPIRING', 'EXTENDED', 'PROMOTING', 'REBUILDING'],
  EXTENDED: ['EXPIRING', 'PROMOTING'],
  EXPIRING: ['PURGED', 'EXTENDED', 'PROMOTING'],
  REBUILDING: ['LIVE', 'FAILED'],
  // Back to the state it came from, or on: which of the three is code's rule.
  PROMOTING: ['PROMOTED', 'LIVE', 'EXTENDED', 'EXPIRING'],
  PROMOTED: [],
  FAILED: [],
  KILLED: [],
  FROZEN: [],
  PURGED: [],
};

/** Every move out of each state: its own exits, plus the safety exits from a slot-holding state. */
export const NEXT_STATES = DEMO_STATES.reduce(
  (next, state) => ({
    ...next,
    [state]: [...EXITS[state], ...(SLOT_HOLDING_STATES.includes(state) ? SAFETY_EXITS : [])],
  }),
  {} as Record<DemoState, readonly DemoState[]>
);

/** The closed set of allowed (from, to) pairs; nothing else is a transition. */
export const DEMO_TRANSITIONS: readonly (readonly [DemoState, DemoState])[] = DEMO_STATES.flatMap(
  (from) => NEXT_STATES[from].map((to) => [from, to] as const)
);

export function isAllowedTransition(from: DemoState, to: DemoState): boolean {
  return NEXT_STATES[from].includes(to);
}

/** No way out. A new demo for the same address is a new demo, never a transition. */
export const TERMINAL_STATES: readonly DemoState[] = DEMO_STATES.filter(
  (state) => NEXT_STATES[state].length === 0
);

/** The states before a term exists: a lease starts on entry to PROVISIONING. */
export const STATES_BEFORE_LEASE: readonly DemoState[] = ['VERIFIED', 'WAITING', 'CLAIMED'];

/** The states that always carry a term; the others may or may not, depending on where they were left from. */
export const STATES_WITH_LEASE: readonly DemoState[] = [
  'PROVISIONING',
  'LIVE',
  'EXTENDED',
  'EXPIRING',
  'REBUILDING',
  'PROMOTING',
  'PROMOTED',
  'PURGED',
];

/** The term in days, set on entry to PROVISIONING (owner ruling). */
export const LEASE_DAYS = 7;

/** What one self-service extension adds to the end of the term (owner ruling). */
export const EXTENSION_DAYS = 14;

/** A hostname label: 20 characters of lower-case base32, 100 bits, inside the 63-character DNS limit. */
export const LABEL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/**
 * Selects a letter from a random byte without bias: the alphabet is 32 long, a
 * power of two that divides the 256 byte values, so the low five bits are
 * uniform. A test pins the length, so a longer alphabet cannot slip in a bias.
 */
export const LABEL_LETTER_MASK = 31;
export const LABEL_LENGTH = 20;
export const LABEL_PATTERN = '^[a-z2-7]{20}$';
