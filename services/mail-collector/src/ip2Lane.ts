import { readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';
import type { Logger } from './log.js';

/**
 * The only enforcement point of the second sending IP's warm-up. The
 * newsletter lane (`mx1Lane` = 'nl') leaves mx1 from that IP, and nothing on
 * mx1 caps it, so every message on that lane takes a place here first: a daily
 * cap by warm-up stage, a cap per destination group inside it, and a hold the
 * operator can set. A message with no place is left unacked, waits, and is
 * offered again; it is never sent on the sign-in address, to Sweego, or any
 * other way. Off unless both file paths are configured. See
 * ../README.md#ip2-newsletter-lane-ip2lanets.
 */

/** The destination groups with their own cap. Every other destination counts against the day's total only. */
export type DestinationGroup = 'gmail' | 'microsoft' | 'yahoo';

export const DESTINATION_GROUPS: readonly DestinationGroup[] = ['gmail', 'microsoft', 'yahoo'];

/** The recipient domains of each group. A domain not listed here belongs to no group. Matched exactly, never as a parent domain. */
export const DESTINATION_DOMAINS: Readonly<Record<DestinationGroup, readonly string[]>> = {
  gmail: ['gmail.com', 'googlemail.com'],
  microsoft: [
    'outlook.com',
    'hotmail.com',
    'live.com',
    'msn.com',
    'outlook.co.uk',
    'hotmail.co.uk',
    'live.co.uk',
  ],
  yahoo: ['yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com'],
};

export interface Ip2StageCaps {
  readonly stage: number;
  /** All destinations together, per UTC day. */
  readonly total: number;
  readonly gmail: number;
  readonly microsoft: number;
  readonly yahoo: number;
}

/**
 * The warm-up table: seven stages, each at least 7 days, advancing only on
 * clean evidence (the operator moves `stage` in the state file; nothing here
 * advances it). Pinned to the accepted design by a test.
 */
export const IP2_STAGES: readonly Ip2StageCaps[] = [
  { stage: 1, total: 50, gmail: 25, microsoft: 15, yahoo: 15 },
  { stage: 2, total: 100, gmail: 50, microsoft: 30, yahoo: 30 },
  { stage: 3, total: 200, gmail: 100, microsoft: 60, yahoo: 60 },
  { stage: 4, total: 400, gmail: 200, microsoft: 120, yahoo: 120 },
  { stage: 5, total: 800, gmail: 400, microsoft: 240, yahoo: 240 },
  { stage: 6, total: 1600, gmail: 800, microsoft: 480, yahoo: 480 },
  { stage: 7, total: 3200, gmail: 1600, microsoft: 960, yahoo: 960 },
];

/**
 * Demo mail rides the newsletter lane too, and its sign-in links must not eat
 * the first sends of the blog: in the stages up to `DEMO_SHARE_LAST_STAGE` demo
 * mail may use at most this percent of the day's total; from the next stage on
 * it may use all of it. One constant, reversible.
 */
export const DEMO_SHARE_PERCENT = 20;
export const DEMO_SHARE_LAST_STAGE = 2;

export const IP2_STATE_PATH_ENV = 'COLLECTOR_IP2_STATE_PATH';
export const IP2_COUNTER_PATH_ENV = 'COLLECTOR_IP2_COUNTER_PATH';

export interface Ip2Paths {
  statePath: string;
  counterPath: string;
}

/** Both set, or neither. A state path without a counter path throws: caps that forget the day on a restart are no caps. */
export function parseIp2Paths(
  statePath: string | undefined,
  counterPath: string | undefined
): Ip2Paths | undefined {
  if (!statePath) {
    if (counterPath) {
      throw new Error(`${IP2_COUNTER_PATH_ENV} is set but ${IP2_STATE_PATH_ENV} is not`);
    }
    return undefined;
  }
  if (!counterPath) {
    throw new Error(`${IP2_STATE_PATH_ENV} is set, so ${IP2_COUNTER_PATH_ENV} must be set too`);
  }
  if (statePath === counterPath) {
    throw new Error(`${IP2_STATE_PATH_ENV} and ${IP2_COUNTER_PATH_ENV} must be different files`);
  }
  return { statePath, counterPath };
}

/** The operator-written file: which stage the lane is at, whether it is held, and which destination groups are held. */
export interface Ip2OperatorState {
  readonly stage: number;
  readonly held: boolean;
  readonly destinationHolds: readonly DestinationGroup[];
}

/** Throws on anything it cannot read exactly: a half-understood state must not release a cap. */
export function parseIp2State(raw: unknown): Ip2OperatorState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('state file must be a JSON object');
  }
  const { stage, held, destinationHolds } = raw as Record<string, unknown>;
  if (
    typeof stage !== 'number' ||
    !Number.isInteger(stage) ||
    !IP2_STAGES.some((s) => s.stage === stage)
  ) {
    throw new Error(`stage must be an integer from 1 to ${IP2_STAGES.length}`);
  }
  if (typeof held !== 'boolean') {
    throw new Error('held must be true or false');
  }
  if (!Array.isArray(destinationHolds)) {
    throw new Error('destinationHolds must be an array');
  }
  const holds: DestinationGroup[] = [];
  for (const entry of destinationHolds) {
    const group = DESTINATION_GROUPS.find((g) => g === entry);
    if (group === undefined) {
      throw new Error(`destinationHolds names an unknown destination group`);
    }
    holds.push(group);
  }
  return { stage, held, destinationHolds: holds };
}

/** The group a recipient address belongs to, or undefined. Case-insensitive, exact domain. */
export function destinationGroupOf(address: string): DestinationGroup | undefined {
  const domain = address
    .slice(address.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase();
  return DESTINATION_GROUPS.find((group) => DESTINATION_DOMAINS[group].includes(domain));
}

export interface Ip2Message {
  readonly id: string;
  /** The recipient address. */
  readonly to: string;
  /** Mail from a demo host. */
  readonly demo: boolean;
}

export type Ip2Refusal =
  | 'held'
  | 'destination_held'
  | 'state_unreadable'
  | 'counter_unreadable'
  | 'counter_write_failed'
  | 'total_cap'
  | 'destination_cap'
  | 'demo_cap';

export interface Ip2Slot {
  /**
   * `accepted`: the place stays used. `not-sent`: the submission definitely
   * took nothing, so the place is given back; anything that may have been
   * taken must be settled `accepted`.
   */
  settle(outcome: 'accepted' | 'not-sent'): void;
}

export type Ip2Decision =
  | { readonly ok: true; readonly slot: Ip2Slot }
  | { readonly ok: false; readonly reason: Ip2Refusal };

export interface Ip2StateView {
  /** Undefined while the state file cannot be read. */
  readonly stage: number | undefined;
  readonly sentToday: number;
  /** The day's total cap at the current stage; undefined while the state file cannot be read. */
  readonly cap: number | undefined;
  /** True while the lane is stopped for any reason: the operator's hold, or an unreadable file. */
  readonly held: boolean;
}

export interface Ip2Lane {
  /**
   * Takes one place for a message before it is submitted, or says why it has
   * none. A message that already holds a place today (a retry) takes no second
   * one. The place is written down before this returns.
   */
  reserve(message: Ip2Message): Ip2Decision;
  state(): Ip2StateView;
}

/** The lane's state at the moment, for the signals that read it. */
export function ip2State(lane: Ip2Lane): Ip2StateView {
  return lane.state();
}

export interface Ip2LaneOptions extends Ip2Paths {
  /** Milliseconds since the epoch. The day is the UTC day of this clock. */
  now?: () => number;
  log?: Logger;
}

interface Counter {
  day: string;
  total: number;
  demo: number;
  destinations: Record<DestinationGroup, number>;
  ids: Set<string>;
}

const COUNTER_VERSION = 1;

function emptyCounter(day: string): Counter {
  return {
    day,
    total: 0,
    demo: 0,
    destinations: { gmail: 0, microsoft: 0, yahoo: 0 },
    ids: new Set(),
  };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseCounter(raw: unknown): Counter {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('counter file must be a JSON object');
  }
  const r = raw as Record<string, unknown>;
  const dest = r.destinations as Record<string, unknown> | null | undefined;
  if (
    r.version !== COUNTER_VERSION ||
    typeof r.day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.day) ||
    !nonNegativeInteger(r.total) ||
    !nonNegativeInteger(r.demo) ||
    typeof dest !== 'object' ||
    dest === null ||
    !nonNegativeInteger(dest.gmail) ||
    !nonNegativeInteger(dest.microsoft) ||
    !nonNegativeInteger(dest.yahoo) ||
    !Array.isArray(r.ids) ||
    !r.ids.every((id) => typeof id === 'string')
  ) {
    throw new Error('counter file has an unrecognised shape');
  }
  return {
    day: r.day,
    total: r.total,
    demo: r.demo,
    destinations: { gmail: dest.gmail, microsoft: dest.microsoft, yahoo: dest.yahoo },
    ids: new Set(r.ids as string[]),
  };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createIp2Lane(opts: Ip2LaneOptions): Ip2Lane {
  const now = opts.now ?? Date.now;
  let counter: Counter | undefined;
  let counterError: string | undefined;
  let lastProblem: string | undefined;

  // One line per change of problem, never one per held message.
  function noteProblem(problem: string | undefined, error?: string): void {
    if (problem === lastProblem) {
      return;
    }
    lastProblem = problem;
    if (problem !== undefined) {
      opts.log?.warn('ip2_lane_held', { reason: problem, error });
    } else {
      opts.log?.info('ip2_lane_recovered', {});
    }
  }

  function readState(): Ip2OperatorState | string {
    try {
      return parseIp2State(JSON.parse(readFileSync(opts.statePath, 'utf8')));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return code === 'ENOENT' ? 'state file is missing' : (error as Error).message;
    }
  }

  // A missing file is a first run, no count. A file that is there and cannot
  // be trusted holds the lane until it can: never a reset on a guess.
  function loadCounter(): void {
    let text: string;
    try {
      text = readFileSync(opts.counterPath, 'utf8');
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT') {
        counter = counter ?? emptyCounter(utcDay(now()));
        counterError = undefined;
        return;
      }
      counterError = (error as Error).message;
      return;
    }
    try {
      counter = parseCounter(JSON.parse(text));
      counterError = undefined;
    } catch (error) {
      counterError = (error as Error).message;
    }
  }

  function persist(c: Counter): void {
    writeFileAtomic(
      opts.counterPath,
      JSON.stringify({
        version: COUNTER_VERSION,
        day: c.day,
        total: c.total,
        demo: c.demo,
        destinations: c.destinations,
        ids: [...c.ids],
      })
    );
  }

  // The count is read once at start-up, and again only while the file is
  // untrusted, so an operator's repair is picked up. A day that has passed
  // starts a fresh count; a day in the future (a clock set back) keeps the
  // count it has rather than resetting it.
  function currentCounter(): Counter | undefined {
    if (counter === undefined || counterError !== undefined) {
      loadCounter();
    }
    if (counter === undefined || counterError !== undefined) {
      return undefined;
    }
    const today = utcDay(now());
    if (counter.day < today) {
      counter = emptyCounter(today);
    }
    return counter;
  }

  loadCounter();

  function refuse(reason: Ip2Refusal, error?: string): Ip2Decision {
    if (reason === 'state_unreadable' || reason === 'counter_unreadable') {
      noteProblem(reason, error);
    }
    return { ok: false, reason };
  }

  function slotFor(day: string, message: Ip2Message, group: DestinationGroup | undefined): Ip2Slot {
    let settled = false;
    return {
      settle(outcome): void {
        if (settled) {
          return;
        }
        settled = true;
        if (outcome === 'accepted') {
          return;
        }
        const c = counter;
        if (c === undefined || c.day !== day || !c.ids.has(message.id)) {
          return;
        }
        c.ids.delete(message.id);
        c.total -= 1;
        if (message.demo) {
          c.demo -= 1;
        }
        if (group !== undefined) {
          c.destinations[group] -= 1;
        }
        try {
          persist(c);
        } catch (error) {
          // The file still says the place is used: the safe side of a cap.
          opts.log?.warn('ip2_counter_write_failed', { error: (error as Error).message });
        }
      },
    };
  }

  return {
    reserve(message: Ip2Message): Ip2Decision {
      const state = readState();
      if (typeof state === 'string') {
        return refuse('state_unreadable', state);
      }
      const c = currentCounter();
      if (c === undefined) {
        return refuse('counter_unreadable', counterError);
      }
      noteProblem(undefined);
      if (state.held) {
        return refuse('held');
      }
      const group = destinationGroupOf(message.to);
      if (group !== undefined && state.destinationHolds.includes(group)) {
        return refuse('destination_held');
      }
      const caps = IP2_STAGES.find((s) => s.stage === state.stage)!;
      const day = c.day;
      if (c.ids.has(message.id)) {
        // A retry of a message that already holds a place: no second place.
        return { ok: true, slot: slotFor(day, message, group) };
      }
      if (c.total >= caps.total) {
        return refuse('total_cap');
      }
      if (group !== undefined && c.destinations[group] >= caps[group]) {
        return refuse('destination_cap');
      }
      if (
        message.demo &&
        state.stage <= DEMO_SHARE_LAST_STAGE &&
        c.demo >= Math.floor((caps.total * DEMO_SHARE_PERCENT) / 100)
      ) {
        return refuse('demo_cap');
      }
      c.ids.add(message.id);
      c.total += 1;
      if (message.demo) {
        c.demo += 1;
      }
      if (group !== undefined) {
        c.destinations[group] += 1;
      }
      try {
        persist(c);
      } catch (error) {
        c.ids.delete(message.id);
        c.total -= 1;
        if (message.demo) {
          c.demo -= 1;
        }
        if (group !== undefined) {
          c.destinations[group] -= 1;
        }
        opts.log?.warn('ip2_counter_write_failed', { error: (error as Error).message });
        return { ok: false, reason: 'counter_write_failed' };
      }
      return { ok: true, slot: slotFor(day, message, group) };
    },

    state(): Ip2StateView {
      const state = readState();
      const c = currentCounter();
      if (typeof state === 'string') {
        return { stage: undefined, sentToday: c?.total ?? 0, cap: undefined, held: true };
      }
      return {
        stage: state.stage,
        sentToday: c?.total ?? 0,
        cap: IP2_STAGES.find((s) => s.stage === state.stage)!.total,
        held: state.held || c === undefined,
      };
    },
  };
}

/**
 * Whether an mx1 submission error means the message was definitely not taken:
 * the connection or login failed, or the server refused the sender or a
 * recipient before any message data. Anything else (a timeout after DATA, an
 * unclassified error) may have been taken, so its place stays used.
 */
export function isDefiniteNonAcceptance(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const command = (error as { command?: unknown }).command;
  return (
    command === 'CONN' ||
    command === 'EHLO' ||
    command === 'HELO' ||
    command === 'STARTTLS' ||
    command === 'AUTH LOGIN' ||
    command === 'AUTH PLAIN' ||
    command === 'MAIL FROM' ||
    command === 'RCPT TO'
  );
}
