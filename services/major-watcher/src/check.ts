import { decide, type WatcherState } from './detect.js';
import { filingCommand, type UpstreamMajorItem } from './filing.js';
import { fileUpstreamMajor, type FiledItem, type FilingConfig } from './issues.js';
import { fetchGhostReleases, type GhostRelease } from './ghostReleases.js';
import { publish, type NtfyConfig } from './ntfy.js';
import { readState, writeState } from './state.js';

// What this watcher does: read an upstream signal, decide, and for a new
// major line do two things and nothing else -- file one tracked item in the
// workspace (idempotent per major, src/issues.ts) and page the platform
// owner. No PR, no merge, no deploy, no model -- unlike the sibling
// minor-release watcher, which opens a PR. A new major starts nothing.
//
// Order: file, then page, then write state. Filing is idempotent, so any
// failure after it leaves state unwritten and the next run retries without a
// second item. A filing failure, a missing credential included, still pages
// (the page is the operational alert and must not depend on the credential),
// says so, and fails the run with state unwritten.

export interface RunOptions {
  readonly statePath: string;
  readonly ntfy: NtfyConfig;
  readonly githubToken?: string;
  /**
   * Reads the filing configuration, throwing when the credential or the launch
   * item is absent. Called only when a new major is found, so a quiet run
   * never needs it. Absent: nothing can be filed (fails closed).
   */
  readonly filingConfig?: () => FilingConfig;
  /** Injected for tests; defaults to the real filer. */
  readonly fileItem?: (config: FilingConfig, item: UpstreamMajorItem) => Promise<FiledItem>;
  readonly fetchReleasesTimeoutMs?: number;
  /** Injected for tests; defaults to the real upstream fetch. */
  readonly fetchReleases?: () => Promise<readonly GhostRelease[]>;
  /** Injected for tests; defaults to the real ntfy publish. */
  readonly publishNtfy?: typeof publish;
}

export interface RunResult {
  readonly notified: boolean;
  /** The tracked item this run filed or found; present only when notified. */
  readonly filed?: FiledItem;
  readonly state: WatcherState;
}

export async function run(options: RunOptions): Promise<RunResult> {
  const state = await readState(options.statePath);

  const releases = options.fetchReleases
    ? await options.fetchReleases()
    : await fetchGhostReleases({
        token: options.githubToken,
        timeoutMs: options.fetchReleasesTimeoutMs,
      });

  const result = decide(releases, state);

  if (!result.shouldNotify) {
    return { notified: false, state };
  }

  const publishFn = options.publishNtfy ?? publish;
  const fileFn = options.fileItem ?? fileUpstreamMajor;
  const tracked = result.tracked as UpstreamMajorItem;

  let filed: FiledItem | undefined;
  let filingError: unknown;
  try {
    if (!options.filingConfig) {
      throw new Error('no filing configuration is wired: no tracked item can be filed');
    }
    filed = await fileFn(options.filingConfig(), tracked);
  } catch (error) {
    filingError = error;
  }

  const filingLines = filed
    ? [
        '',
        `${filed.created ? 'Tracked item filed' : 'Tracked item already filed'} under the launch item: ${filed.url}`,
      ]
    : [
        '',
        `FILING FAILED, nothing was filed: ${filingError instanceof Error ? filingError.message : String(filingError)}. This run is red and the next run retries. To file it by hand, paste only the command below:`,
        filingCommand(tracked),
      ];

  await publishFn(options.ntfy, {
    title: result.title as string,
    message: [result.message as string, ...filingLines].join('\n'),
    priority: 'high',
    tags: ['ghost', 'major-version'],
  });

  // Filing failed: the page went out, state stays unwritten, the run is red.
  if (filingError !== undefined) throw filingError;

  await writeState(options.statePath, result.nextState);

  return { notified: true, filed, state: result.nextState };
}
