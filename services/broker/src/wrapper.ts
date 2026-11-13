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

const LINE_BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/;
// Every C0 control character, DEL, and the Unicode line separators that a
// line-based reader may treat as a line break.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;

function escapeControlChar(char: string): string {
  if (char === '\r') return '\\r';
  if (char === '\n') return '\\n';
  if (char === '\t') return '\\t';
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/**
 * Text as one log-safe line: every C0 control character, DEL, U+0085, U+2028
 * and U+2029 written as a visible escape (`\r`, `\n`, `\t`, else `\uXXXX`).
 * See wrapper.md#stderr-on-one-line.
 */
export function escapeControls(text: string): string {
  return text.replace(CONTROL_CHARS, escapeControlChar);
}

/** A child's stderr as one log-safe line: trimmed, then control-escaped. */
export function stderrOneLine(stderr: string): string {
  return escapeControls(stderr.trim());
}

/**
 * `message` is the client-safe head line only: it can reach an HTTP body.
 * The child's stderr rides on `stderr` and is printed into the log by
 * `errorLogText`, never into a reply. See wrapper.md#stderr-on-one-line.
 */
export class WrapperError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message);
    this.name = 'WrapperError';
  }

  /** The message and, when there is any, the child's stderr on the same line. For the log only. */
  get logMessage(): string {
    const reason = stderrOneLine(this.stderr);
    return reason === '' ? this.message : `${this.message} stderr: ${reason}`;
  }
}

/** What a logger prints for a caught error: a WrapperError's `logMessage`, else its `message`. */
export function errorLogText(err: unknown): string {
  if (err instanceof WrapperError) return err.logMessage;
  return (err as Error).message;
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
          // Node puts the child's stderr after the first line of err.message.
          // Only that first line is the message (it can reach an HTTP body);
          // the stderr stays on the error for the log line.
          const [head = ''] = err.message.split(LINE_BREAKS);
          reject(new WrapperError(`slot wrapper failed: ${escapeControls(head)}`, stdout, stderr));
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
