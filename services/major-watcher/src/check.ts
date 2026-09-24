import { decide, type WatcherState } from './detect.js';
import { fetchGhostReleases, type GhostRelease } from './ghostReleases.js';
import { publish, type NtfyConfig } from './ntfy.js';
import { readState, writeState } from './state.js';

// The one thing this watcher is allowed to do (branchLeft/workspace#1301,
// D38/D39/D42): read an upstream signal, decide, and either page Rob or do
// nothing. No PR, no merge, no deploy, no second system touched -- unlike
// its sibling #1252 (the minor-release watcher), which opens a PR. A new
// major or preview only ever informs; nothing here acts on it.

export interface RunOptions {
  readonly statePath: string;
  readonly ntfy: NtfyConfig;
  readonly githubToken?: string;
  /** Injected for tests; defaults to the real upstream fetch. */
  readonly fetchReleases?: () => Promise<readonly GhostRelease[]>;
  /** Injected for tests; defaults to the real ntfy publish. */
  readonly publishNtfy?: typeof publish;
}

export interface RunResult {
  readonly notified: boolean;
  readonly state: WatcherState;
}

export async function run(options: RunOptions): Promise<RunResult> {
  const state = await readState(options.statePath);

  const releases = options.fetchReleases
    ? await options.fetchReleases()
    : await fetchGhostReleases({ token: options.githubToken });

  const result = decide(releases, state);

  if (!result.shouldNotify) {
    return { notified: false, state };
  }

  const publishFn = options.publishNtfy ?? publish;
  await publishFn(options.ntfy, {
    title: result.title as string,
    message: result.message as string,
    priority: 'high',
    tags: ['ghost', 'major-version'],
  });

  await writeState(options.statePath, result.nextState);

  return { notified: true, state: result.nextState };
}
