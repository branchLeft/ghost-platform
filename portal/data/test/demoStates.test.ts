import { describe, expect, it } from 'vitest';
import {
  EXTENSION_DAYS,
  ForbiddenTransitionError,
  ExtensionRefusedError,
  InvalidDemoIdError,
  LEASE_DAYS,
  assertExtensionAllowed,
  assertTransitionAllowed,
  generateLabel,
  parseDemoId,
} from '../src/demoLifecycle.js';
import {
  DEMO_STATES,
  DEMO_TRANSITIONS,
  LABEL_ALPHABET,
  LABEL_LENGTH,
  LABEL_PATTERN,
  SLOT_HOLDING_STATES,
  STATES_BEFORE_LEASE,
  STATES_WITH_LEASE,
  TERMINAL_STATES,
  isAllowedTransition,
  type DemoState,
} from '../src/demoStates.js';

// The transition set as the lifecycle design's table states it, written out
// here pair by pair so the code's own derivation is not its own oracle.
const DESIGN_EXITS: Record<string, string[]> = {
  VERIFIED: ['CLAIMED', 'WAITING'],
  WAITING: ['CLAIMED'],
  CLAIMED: ['PROVISIONING', 'WAITING', 'KILLED', 'FROZEN'],
  PROVISIONING: ['LIVE', 'FAILED', 'KILLED', 'FROZEN'],
  LIVE: ['EXPIRING', 'EXTENDED', 'PROMOTING', 'REBUILDING', 'KILLED', 'FROZEN'],
  EXTENDED: ['EXPIRING', 'PROMOTING', 'KILLED', 'FROZEN'],
  EXPIRING: ['PURGED', 'EXTENDED', 'PROMOTING', 'KILLED', 'FROZEN'],
  REBUILDING: ['LIVE', 'FAILED', 'KILLED', 'FROZEN'],
  PROMOTING: ['PROMOTED', 'LIVE', 'EXTENDED', 'EXPIRING', 'KILLED', 'FROZEN'],
  PROMOTED: [],
  FAILED: [],
  KILLED: [],
  FROZEN: [],
  PURGED: [],
};

describe('the closed state list and transition set', () => {
  it('names the fourteen states of the design, and no other', () => {
    expect([...DEMO_STATES].sort()).toEqual(Object.keys(DESIGN_EXITS).sort());
  });

  it.each(DEMO_STATES.flatMap((from) => DEMO_STATES.map((to) => [from, to] as const)))(
    '%s to %s is allowed by the set exactly when the design allows it',
    (from, to) => {
      const designAllows = DESIGN_EXITS[from]!.includes(to);
      expect(isAllowedTransition(from, to)).toBe(designAllows);
    }
  );

  it('lists each allowed pair once, and as many as the design has', () => {
    const designPairs = Object.values(DESIGN_EXITS).reduce((sum, exits) => sum + exits.length, 0);
    expect(DEMO_TRANSITIONS).toHaveLength(designPairs);
    expect(new Set(DEMO_TRANSITIONS.map(([from, to]) => `${from}>${to}`)).size).toBe(designPairs);
  });

  it('refuses every self-transition and every move out of a terminal state', () => {
    for (const state of DEMO_STATES) expect(isAllowedTransition(state, state)).toBe(false);
    expect([...TERMINAL_STATES].sort()).toEqual(
      ['FAILED', 'FROZEN', 'KILLED', 'PROMOTED', 'PURGED'].sort()
    );
    for (const terminal of TERMINAL_STATES) {
      for (const to of DEMO_STATES) expect(isAllowedTransition(terminal, to)).toBe(false);
    }
  });

  it('lets the kill switch and the content flag leave every slot-holding state, and only those', () => {
    expect([...SLOT_HOLDING_STATES].sort()).toEqual(
      ['CLAIMED', 'EXPIRING', 'EXTENDED', 'LIVE', 'PROMOTING', 'PROVISIONING', 'REBUILDING'].sort()
    );
    for (const state of DEMO_STATES) {
      const holds = SLOT_HOLDING_STATES.includes(state);
      expect(isAllowedTransition(state, 'KILLED')).toBe(holds);
      expect(isAllowedTransition(state, 'FROZEN')).toBe(holds);
    }
  });

  it('splits the states into those before a term, those with one, and the three that may be either', () => {
    expect(STATES_BEFORE_LEASE).toEqual(['VERIFIED', 'WAITING', 'CLAIMED']);
    const either = DEMO_STATES.filter(
      (state) => !STATES_BEFORE_LEASE.includes(state) && !STATES_WITH_LEASE.includes(state)
    );
    expect([...either].sort()).toEqual(['FAILED', 'FROZEN', 'KILLED']);
  });

  it('holds the rulings: seven days and a 14 day extension', () => {
    expect(LEASE_DAYS).toBe(7);
    expect(EXTENSION_DAYS).toBe(14);
  });
});

describe('assertTransitionAllowed', () => {
  it('refuses a pair outside the set, naming it', () => {
    const attempt = (): void =>
      assertTransitionAllowed({ state: 'LIVE', origin: 'PROVISIONING' }, 'VERIFIED');
    expect(attempt).toThrow(ForbiddenTransitionError);
    expect(attempt).toThrow('LIVE to VERIFIED is not an allowed transition');
  });

  it('keeps an extension to the extend operation', () => {
    expect(() =>
      assertTransitionAllowed({ state: 'LIVE', origin: 'PROVISIONING' }, 'EXTENDED')
    ).toThrow(/use extend/);
    expect(() =>
      assertTransitionAllowed({ state: 'EXPIRING', origin: 'LIVE' }, 'EXTENDED')
    ).toThrow(/use extend/);
  });

  it('returns a promotion to the state it came from, or completes it, or ends it by a safety exit', () => {
    const promoting = (origin: DemoState) => ({ state: 'PROMOTING' as const, origin });
    expect(() => assertTransitionAllowed(promoting('LIVE'), 'LIVE')).not.toThrow();
    expect(() => assertTransitionAllowed(promoting('EXTENDED'), 'EXTENDED')).not.toThrow();
    expect(() => assertTransitionAllowed(promoting('EXPIRING'), 'EXPIRING')).not.toThrow();
    expect(() => assertTransitionAllowed(promoting('EXPIRING'), 'PROMOTED')).not.toThrow();
    expect(() => assertTransitionAllowed(promoting('LIVE'), 'KILLED')).not.toThrow();
    expect(() => assertTransitionAllowed(promoting('LIVE'), 'FROZEN')).not.toThrow();
    expect(() => assertTransitionAllowed(promoting('LIVE'), 'EXPIRING')).toThrow(
      'a promotion returns to LIVE'
    );
    expect(() => assertTransitionAllowed(promoting('EXTENDED'), 'LIVE')).toThrow(
      ForbiddenTransitionError
    );
  });
});

describe('assertExtensionAllowed', () => {
  it.each(DEMO_STATES.filter((state) => state !== 'LIVE' && state !== 'EXPIRING'))(
    'refuses an extension in %s',
    (state) => {
      const attempt = (): void => assertExtensionAllowed('demo', state, 0);
      expect(attempt).toThrow(ExtensionRefusedError);
      expect(attempt).toThrow('only while LIVE or EXPIRING');
    }
  );

  it('allows the first self-service extension in LIVE and EXPIRING, and refuses a second', () => {
    expect(() => assertExtensionAllowed('demo', 'LIVE', 0)).not.toThrow();
    expect(() => assertExtensionAllowed('demo', 'EXPIRING', 0)).not.toThrow();
    for (const state of ['LIVE', 'EXPIRING'] as const) {
      const attempt = (): void => assertExtensionAllowed('demo', state, 1);
      expect(attempt).toThrow(ExtensionRefusedError);
      expect(attempt).toThrow('used its one self-service extension');
    }
  });
});

describe('generateLabel', () => {
  it('makes 20 lower-case base32 characters that match the shape the table pins', () => {
    const label = generateLabel();
    expect(label).toHaveLength(LABEL_LENGTH);
    expect(label).toMatch(new RegExp(LABEL_PATTERN));
    expect([...label].every((letter) => LABEL_ALPHABET.includes(letter))).toBe(true);
  });

  it('keeps the pattern, the alphabet and the length in step', () => {
    expect(LABEL_ALPHABET).toHaveLength(32);
    expect(LABEL_PATTERN).toBe(`^[a-z2-7]{${LABEL_LENGTH}}$`);
    expect(LABEL_LENGTH * 5).toBe(100);
    expect(LABEL_ALPHABET).toMatch(/^[a-z2-7]+$/);
  });

  it('differs between calls', () => {
    const labels = new Set(Array.from({ length: 200 }, () => generateLabel()));
    expect(labels.size).toBe(200);
  });

  it('uses every letter equally from the random source: byte value mod 32 chooses the letter', () => {
    const bytes = Uint8Array.from({ length: LABEL_LENGTH }, (_, index) => index * 13 + 5);
    const label = generateLabel(() => bytes);
    expect([...label]).toEqual(
      [...bytes].map((byte) => LABEL_ALPHABET.charAt(byte % LABEL_ALPHABET.length))
    );
    expect(generateLabel(() => new Uint8Array(LABEL_LENGTH).fill(255))).toBe(
      LABEL_ALPHABET.charAt(31).repeat(LABEL_LENGTH)
    );
  });

  it('takes nothing from a demo, a prospect or a slot: the only input is the random source', () => {
    expect(generateLabel.length).toBe(0);
  });
});

describe('parseDemoId', () => {
  it('accepts a canonical lower-case UUID', () => {
    expect(parseDemoId('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111'
    );
  });

  it.each([
    '',
    'not-a-uuid',
    '11111111-1111-4111-8111-11111111111G',
    '1111111111114111811111111111111',
  ])('refuses %j', (value) => {
    expect(() => parseDemoId(value)).toThrow(InvalidDemoIdError);
  });
});
