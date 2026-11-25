import type { RingBakeConfig } from './rings.js';
import {
  runRelease,
  type Release,
  type ReleaseOutcome,
  type RingControllerDependencies,
} from './ringController.js';
import type { ModelFreeEnvironment } from './modelFreeEnvironment.js';

/**
 * The one read of the process environment in this package. Both process
 * entries take their environment from here: the release controller hands it to
 * `runRelease` as it stands, and the host entry reads its configuration from
 * it. A caller cannot pass a scrubbed environment while the process itself
 * holds a model key, because it passes none.
 */
const env: ModelFreeEnvironment = process.env;

/** The process environment, as the one process entry reads it. */
export function processEnvironment(): ModelFreeEnvironment {
  return env;
}

export function runReleaseFromProcess(
  release: Release,
  deps: RingControllerDependencies,
  config: RingBakeConfig
): Promise<ReleaseOutcome> {
  return runRelease(release, deps, config, env);
}
