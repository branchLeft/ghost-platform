import { RING_ORDER, type RingName } from './rings.js';
import type { RingControllerDependencies, RingMember } from './ringController.js';

/**
 * Which tenants sit in which ring: tenant ids only, one list per ring.
 * The engine is deliberately not part of it (see `createListMembers`).
 */
export type RingAssignments = Readonly<Record<RingName, readonly string[]>>;

/** Reads a tenant's engine from where it is actually recorded, never from the assignment data. */
export type EngineOf = (tenantId: string) => RingMember['engine'] | Promise<RingMember['engine']>;

/** The assignment data is wrong. Raised before any ring is entered, never mid-release. */
export class RingAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RingAssignmentError';
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Strict by construction: every ring is named, nothing else is, a tenant
 * is in exactly one ring. A misspelt ring or a tenant listed twice would
 * otherwise quietly place a tenant in a ring it was never meant for, and a
 * bump there is a bump of a live tenant ahead of its turn.
 */
export function parseRingAssignments(input: unknown): RingAssignments {
  if (!isPlainObject(input)) {
    throw new RingAssignmentError('ring assignments must be an object keyed by ring name');
  }
  for (const key of Object.keys(input)) {
    if (!(RING_ORDER as readonly string[]).includes(key)) {
      throw new RingAssignmentError(`unknown ring '${key}'`);
    }
  }
  const ringOf = new Map<string, RingName>();
  const parsed = {} as Record<RingName, readonly string[]>;
  for (const ring of RING_ORDER) {
    const list = input[ring];
    if (!Array.isArray(list)) {
      throw new RingAssignmentError(`ring '${ring}' must be named, with a list of tenant ids`);
    }
    const ids: string[] = [];
    for (const id of list as unknown[]) {
      if (typeof id !== 'string' || id.trim() === '' || id !== id.trim()) {
        throw new RingAssignmentError(
          `ring '${ring}' holds a tenant id that is not a plain string`
        );
      }
      const already = ringOf.get(id);
      if (already !== undefined) {
        throw new RingAssignmentError(
          already === ring
            ? `a tenant is listed twice in ring '${ring}'`
            : `a tenant is in both ring '${already}' and ring '${ring}'`
        );
      }
      ringOf.set(id, ring);
      ids.push(id);
    }
    parsed[ring] = Object.freeze(ids);
  }
  return Object.freeze(parsed);
}

/**
 * The controller's `listMembers`, built from the assignments. A member's
 * engine is read through `engineOf`, so a tenant cannot satisfy the MySQL
 * canary rule by being labelled MySQL in the data that places it. An engine
 * that cannot be read, or is neither engine, throws, which the controller
 * turns into a hold: a ring is never run on a guess.
 */
export function createListMembers(
  assignments: RingAssignments,
  engineOf: EngineOf
): RingControllerDependencies['listMembers'] {
  return async (ring) => {
    const ids = assignments[ring] as readonly string[] | undefined;
    if (ids === undefined) {
      throw new RingAssignmentError(`no assignment for ring '${String(ring)}'`);
    }
    const members: RingMember[] = [];
    for (const tenantId of ids) {
      const engine = await engineOf(tenantId);
      if (engine !== 'sqlite' && engine !== 'mysql') {
        throw new RingAssignmentError(`tenant in ring '${ring}' has an engine that is not known`);
      }
      members.push({ tenantId, engine });
    }
    return members;
  };
}
