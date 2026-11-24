import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPromotionRecorderFromEnv,
  ENV_HEAD_FILE,
  ENV_LOG_FILE,
  ENV_PUBLIC_KEY_FILE,
  ENV_SIGNING_KEY_FILE,
  type PromotionRecorder,
} from './promotionRecorder.js';
import { processEnvironment } from './processEntry.js';

/**
 * The process entry of the one tick, `bin/ring-controller` in the release
 * bundle. It reads the host's configuration (the names the ring_controller_host
 * role writes, and the directory systemd names in CREDENTIALS_DIRECTORY), builds
 * the dependencies this build can build from it, and refuses to run a tick it
 * cannot complete. It never reports a tick that did nothing as a success.
 */

/** The state directory the role makes; the promotion record lives under it. */
export const HOST_STATE_DIR = 'RING_CONTROLLER_STATE_DIR';
/** The name the unit gives the record-signing key under $CREDENTIALS_DIRECTORY. */
export const HOST_KEY_NAME = 'RING_CONTROLLER_RECORD_SIGNING_KEY_NAME';
/** The committed public half of the record-signing key, SPKI PEM. */
export const HOST_PUBLIC_KEY_FILE = 'RING_CONTROLLER_RECORD_PUBLIC_KEY_FILE';
/** Set by systemd for a unit with LoadCredential=. */
export const HOST_CREDENTIALS_DIR = 'CREDENTIALS_DIRECTORY';

/** The subdirectory of the state directory the promotion record is kept in. */
export const PROMOTION_RECORD_DIR = 'promotion-record';

/** EX_UNAVAILABLE, the code the bundle launcher exits with: nothing was run. */
export const EXIT_NOTHING_RUN = 69;
/** EX_CONFIG: the host configuration, or a key or record it names, is refused. */
export const EXIT_CONFIG = 78;

/**
 * The adapters a tick needs that no code in this package builds yet. A tick
 * cannot complete without them, so the entry refuses and names them.
 */
export const UNWIRED_ADAPTERS: readonly string[] = Object.freeze([
  'the ring membership source',
  'the release to take through the rings',
  'the release gates',
  'the per-tenant bump (backup, colour switch, migration)',
  'the health and reported-error probes',
  'the hold sink',
]);

export type Environment = Readonly<Record<string, string | undefined>>;

/** A host input is unset, empty, not absolute, or not a plain file name where one is required. Names the input, never a value. */
export class HostConfigError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} is missing or refused`);
    this.name = 'HostConfigError';
  }
}

function requiredPath(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || !isAbsolute(value)) throw new HostConfigError(name);
  return value;
}

function requiredName(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new HostConfigError(name);
  }
  return value;
}

/**
 * Turns the host's inputs into the four variables `createPromotionRecorderFromEnv`
 * reads. The log and head sit under the state directory; the signing key is the
 * copy systemd made under the credentials directory, never the path on disk.
 */
export function recorderEnvFromHost(env: Environment): Record<string, string> {
  const stateDir = requiredPath(env, HOST_STATE_DIR);
  const keyName = requiredName(env, HOST_KEY_NAME);
  const credentialsDir = requiredPath(env, HOST_CREDENTIALS_DIR);
  const publicKeyFile = requiredPath(env, HOST_PUBLIC_KEY_FILE);
  const recordDir = join(stateDir, PROMOTION_RECORD_DIR);
  return {
    [ENV_LOG_FILE]: join(recordDir, 'promotion-chain.log'),
    [ENV_HEAD_FILE]: join(recordDir, 'promotion-head.json'),
    [ENV_SIGNING_KEY_FILE]: join(credentialsDir, keyName),
    [ENV_PUBLIC_KEY_FILE]: publicKeyFile,
  };
}

export interface HostTickOptions {
  env: Environment;
  /** Opens the promotion recorder. Defaults to the real key loader and record. */
  openRecorder?: (env: Record<string, string>, now: () => Date) => Promise<PromotionRecorder>;
  now?: () => Date;
  /** Where refusals are written. Defaults to standard error. */
  report?: (line: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the entry and returns its exit code. Config refused: EXIT_CONFIG, naming
 * the input. Key or record refused: EXIT_CONFIG, naming the refusal. Otherwise
 * EXIT_NOTHING_RUN, naming what this build cannot build yet.
 */
export async function runHostTick(options: HostTickOptions): Promise<number> {
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  const openRecorder = options.openRecorder ?? createPromotionRecorderFromEnv;
  const now = options.now ?? (() => new Date());

  let recorderEnv: Record<string, string>;
  try {
    recorderEnv = recorderEnvFromHost(options.env);
  } catch (error) {
    report(`ring-controller: host configuration refused: ${messageOf(error)}. Nothing was run.`);
    return EXIT_CONFIG;
  }

  try {
    await openRecorder(recorderEnv, now);
  } catch (error) {
    report(
      `ring-controller: record-signing key or promotion record refused: ${messageOf(error)}. Nothing was run.`
    );
    return EXIT_CONFIG;
  }

  report(
    `ring-controller: this build has no adapter for ${UNWIRED_ADAPTERS.join(', ')}. Nothing was run.`
  );
  return EXIT_NOTHING_RUN;
}

/** The typed configuration of the process entry: the environment it was started with. */
export interface HostEntryConfig {
  readonly env: Environment;
}

/** The process entry: runs one tick against the configuration it is given and sets the exit code. */
export async function main(config: HostEntryConfig): Promise<void> {
  process.exitCode = await runHostTick({ env: config.env });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main({ env: processEnvironment() });
}
