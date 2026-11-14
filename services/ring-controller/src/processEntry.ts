import type { RingBakeConfig } from './rings.js';
import {
  runRelease,
  type Release,
  type ReleaseOutcome,
  type RingControllerDependencies,
} from './ringController.js';

/**
 * The entry a real process calls. The only place in `src/` that reads the
 * process environment, and it hands it to `runRelease` as it stands: not a
 * copy, not a filtered view. A caller cannot pass a scrubbed environment
 * while the process itself holds a model key, because it passes none.
 */
export function runReleaseFromProcess(
  release: Release,
  deps: RingControllerDependencies,
  config: RingBakeConfig
): Promise<ReleaseOutcome> {
  return runRelease(release, deps, config, process.env);
}
