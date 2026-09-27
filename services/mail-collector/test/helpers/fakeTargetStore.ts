import type { DrainTarget, TargetStore } from '../../src/descriptorTargets.js';

/**
 * A plain, in-memory TargetStore double -- lets a collectorLoop test drive
 * membership directly (add/remove a target mid-run) without also having to
 * fake a descriptor directory on disk. descriptorTargets.test.ts is what
 * proves the real DescriptorTargetStore reads only the tenant/demo
 * descriptor; this double is only ever used to prove the LOOP respects
 * whatever a TargetStore says, never anything else.
 */
export function createFakeTargetStore(initial: DrainTarget[] = []): TargetStore & {
  setTargets(targets: DrainTarget[]): void;
} {
  let targets = initial;
  return {
    get targets(): readonly DrainTarget[] {
      return targets;
    },
    isStale: false,
    async refresh(): Promise<void> {
      // No-op: this double's targets are set directly by the test, not by
      // reading anything on a timer.
    },
    setTargets(next: DrainTarget[]): void {
      targets = next;
    },
  };
}
