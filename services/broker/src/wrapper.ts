import { execFile } from 'node:child_process';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import type { Colour, Verb } from './literals.js';

export interface SlotWrapper {
  start(slot: SlotName, colour: Colour): Promise<void>;
  stop(slot: SlotName, colour: Colour): Promise<void>;
  reset(slot: SlotName): Promise<void>;
  /**
   * The enumerated `load <path>` verb. Unlike `start`/`stop`/`reset`, the
   * path argument is not sudoers-enumerable, so the caller
   * (`plugins/dockerImageLoader.ts`) must never pass anything but the
   * fixed staging path. Resolves to `docker load`'s stdout, unlike the
   * other verbs, which discard it. See wrapper.md#slotwrapper-load.
   */
  load(tarPath: string): Promise<string>;
}

export class WrapperError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message);
    this.name = 'WrapperError';
  }
}

export interface WrapperConfig {
  readonly command: string;
  /** Prepended argv -- `['sudo', '-n']` in production. */
  readonly prefix: readonly string[];
  readonly timeoutMs: number;
}

/**
 * Every invocation is `execFile` with an explicit argv array, never a
 * shell string: sudo compares the *space-joined text* of the argv it
 * receives against each configured command, not argv element by element,
 * so a single argv element holding a space could otherwise impersonate two
 * separate arguments. This function never joins or interpolates
 * slot/colour/verb into one element. See wrapper.md#createslotwrapper.
 */
export function createSlotWrapper(config: WrapperConfig): SlotWrapper {
  function run(args: readonly string[]): Promise<string> {
    const argv = [...config.prefix, config.command, ...args];
    const [file, ...rest] = argv;
    if (!file) return Promise.reject(new Error('wrapper command is empty'));
    return new Promise((resolve, reject) => {
      execFile(file, rest, { timeout: config.timeoutMs }, (err, stdout, stderr) => {
        if (err) {
          reject(new WrapperError(`slot wrapper failed: ${err.message}`, stdout, stderr));
          return;
        }
        resolve(stdout);
      });
    });
  }

  return {
    start: (slot, colour) => run([slot, colour, 'start' satisfies Verb]).then(() => undefined),
    stop: (slot, colour) => run([slot, colour, 'stop' satisfies Verb]).then(() => undefined),
    reset: (slot) => run([slot, 'reset']).then(() => undefined),
    // 'load' and the path are pushed as their own argv elements, same as
    // every other verb here -- never joined into one, for the identical
    // reason the module doc comment above gives for slot/colour/verb.
    load: (tarPath) => run(['load', tarPath]),
  };
}
