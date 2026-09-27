import { execFile } from 'node:child_process';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import type { Colour, Verb } from './literals.js';

export interface SlotWrapper {
  start(slot: SlotName, colour: Colour): Promise<void>;
  stop(slot: SlotName, colour: Colour): Promise<void>;
  reset(slot: SlotName): Promise<void>;
  /**
   * The enumerated `load <path>` verb (`render_slot_sudoers.py`'s
   * `IMAGE_LOAD_INVOCATION`) -- unlike `start`/`stop`/`reset`, the path
   * argument is not sudoers-enumerable (it names a file, not one of a
   * finite set of literals), so the sudoers grant fixes it to the single
   * literal path the image-staging directory's own fixed filename
   * produces; the caller (`plugins/dockerImageLoader.ts`) is the one that
   * must never pass anything else. Resolves to the wrapped `docker load`'s
   * own stdout, unlike the other three verbs, which discard it -- nothing
   * else this wrapper runs has output a caller needs back.
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
 * Every invocation is `execFile` with an explicit argv array -- never a
 * shell string. `execFile` never spawns a shell to begin with, so there is
 * no metacharacter for any input to abuse regardless; the discipline this
 * function actually has to hold is narrower and specific to how sudoers
 * matches: sudo compares the *space-joined text* of the argv it receives
 * against each configured command, not argv element by element (this was
 * measured against real `sudo -n`, see workspace#1188's review comment on
 * PR#227). So `sudo branchleft-slot '0 reset'` -- one argv element holding
 * a space -- produces the exact same space-joined text as the intended
 * `<slot> reset` two-element form and is equally permitted by the
 * sudoers file, but the wrapper then receives one argument instead of two.
 * This function is the one place that builds that argv, and it never joins
 * or interpolates a slot/colour/verb into a single element: `slot`,
 * `colour` and `verb` each arrive here already validated against their own
 * closed set (`literals.ts`) and are each pushed as their own argv element,
 * so the sudoers boundary and this process's own argv agree on where one
 * argument ends and the next begins.
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
