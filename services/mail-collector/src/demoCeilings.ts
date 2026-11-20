import { readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';

/**
 * Why a demo message was not given a place under a ceiling: `slot` is its own
 * slot's ceiling, `estate` the one every demo slot shares.
 */
export type CeilingRefusal = 'slot' | 'estate';

/**
 * The two ceilings of LLD-6 section 05, counted where a compromised demo host
 * cannot reach them: per slot (enough to try sign-up and a test send) and per
 * estate (a hard cap every demo slot shares, so one abuser cannot spend
 * everyone's). Both count messages in a rolling window, and both are keyed on
 * the slot's identity (its descriptor slug), never on a client address: no
 * address-keyed path exists here, so none can be reached over IPv6 to dodge it.
 * See ../README.md#demo-mail-containment.
 */
export interface DemoCeilings {
  /**
   * Takes one place for a message, or says which ceiling is full. A message id
   * that already holds a place in the window gets it again at no cost, so a
   * re-offer after a lost ack or a failed submission never spends a second
   * place. A refusal takes nothing.
   */
  reserve(slot: string, messageId: string, slotCeiling?: number): 'ok' | CeilingRefusal;
  /** Places held in the window, for tests and signals. */
  readonly size: number;
}

export interface DemoCeilingsOptions {
  /** Messages every demo slot together may send in one window. */
  estateCeiling: number;
  /** A slot's own ceiling when its descriptor names none. */
  defaultSlotCeiling: number;
  /** The rolling window the ceilings count in, in milliseconds. */
  windowMs: number;
  now?: () => number;
  /**
   * File the places are kept in, on a volume that outlives the process, so a
   * restart does not hand every slot a fresh ceiling. Unset, a restart forgets them.
   */
  statePath?: string;
  /** Called with a state-file read or write failure; the ceilings never throw for one. */
  onError?: (error: Error) => void;
}

interface Place {
  readonly slot: string;
  readonly at: number;
}

const STATE_VERSION = 1;

function wholeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function createDemoCeilings(options: DemoCeilingsOptions): DemoCeilings {
  const { statePath, windowMs, onError } = options;
  const now = options.now ?? Date.now;
  const places = new Map<string, Place>();

  function report(error: unknown): void {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  function persist(): void {
    if (!statePath) {
      return;
    }
    try {
      writeFileAtomic(
        statePath,
        JSON.stringify({
          version: STATE_VERSION,
          places: [...places].map(([key, place]) => ({ key, ...place })),
        })
      );
    } catch (error) {
      report(error);
    }
  }

  function load(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') {
        report(error);
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; places?: unknown };
      if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.places)) {
        throw new Error('demo ceiling state file has an unrecognised shape');
      }
      for (const row of parsed.places as unknown[]) {
        const r = row as { key?: unknown; slot?: unknown; at?: unknown } | null;
        if (
          typeof r === 'object' &&
          r !== null &&
          typeof r.key === 'string' &&
          typeof r.slot === 'string' &&
          typeof r.at === 'number' &&
          Number.isFinite(r.at)
        ) {
          places.set(r.key, { slot: r.slot, at: r.at });
        }
      }
    } catch (error) {
      report(error);
    }
  }

  function prune(at: number): boolean {
    let changed = false;
    for (const [key, place] of places) {
      if (at - place.at >= windowMs) {
        places.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  if (statePath) {
    load(statePath);
  }

  return {
    reserve(slot, messageId, slotCeiling) {
      const at = now();
      const pruned = prune(at);
      const key = `${slot}\u0000${messageId}`;
      if (places.has(key)) {
        if (pruned) {
          persist();
        }
        return 'ok';
      }
      const ceiling = wholeNonNegative(slotCeiling) ? slotCeiling : options.defaultSlotCeiling;
      let inSlot = 0;
      for (const place of places.values()) {
        if (place.slot === slot) {
          inSlot += 1;
        }
      }
      let verdict: 'ok' | CeilingRefusal = 'ok';
      if (inSlot >= ceiling) {
        verdict = 'slot';
      } else if (places.size >= options.estateCeiling) {
        verdict = 'estate';
      }
      if (verdict === 'ok') {
        places.set(key, { slot, at });
      }
      if (verdict === 'ok' || pruned) {
        persist();
      }
      return verdict;
    },
    get size(): number {
      return places.size;
    },
  };
}
