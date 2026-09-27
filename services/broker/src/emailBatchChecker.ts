import { execFile } from 'node:child_process';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import type { Colour } from './literals.js';

/**
 * LLD-4 §U5, load-bearing: blue is not stopped while it holds an email or
 * batch in `submitting` -- Ghost promotes an orphaned `submitting` batch to
 * `failed` rather than resending it, so stopping a colour mid-send costs a
 * reader a partial newsletter.
 *
 * A seam (like `AdminApiClient`, `adminApi.ts`'s own doc comment) rather
 * than a query inlined into `app.ts`, so `/stop`'s own tests can drive it
 * without a real sudo call. `createSudoEmailBatchChecker`, below, is the
 * real implementation: the owner's ruling on this seam's own open design
 * question was a new read-only verb in the sudoers-enumerated wrapper
 * (`demo-host/provision/branchleft_slot_wrapper.py`'s `email-batches`),
 * never a second privileged path of the broker's own.
 */
export interface EmailBatchChecker {
  hasSubmittingBatch(slot: SlotName): Promise<boolean>;
}

/**
 * The safe default when no checker is configured at all: reports a
 * submitting batch unconditionally, so `/stop` always refuses rather than
 * admit a guess. `server.ts` wires `createSudoEmailBatchChecker` as the
 * real default; this stays exported for a sandbox, a test, or
 * `BROKER_EMAIL_BATCH_CHECKER_MODULE` naming no plugin of its own.
 */
export function createFailClosedEmailBatchChecker(): EmailBatchChecker {
  return {
    async hasSubmittingBatch() {
      return true;
    },
  };
}

export interface SudoEmailBatchCheckerConfig {
  /** The forced-command wrapper's path -- `wrapper.ts`'s own `WrapperConfig.command`. */
  readonly command: string;
  /** Prepended argv -- `['sudo', '-n']` in production, matching `wrapper.ts`. */
  readonly prefix: readonly string[];
  readonly timeoutMs: number;
}

/**
 * A bare non-negative integer and nothing else -- the exact contract
 * `branchleft_slot_wrapper.py`'s `main()` promises on success (`print(count)`,
 * nothing else to stdout). Anything else -- extra text, a negative number,
 * a decimal -- is treated as untrustworthy output, never parsed loosely
 * with a regex that might accept a prefix of something malformed.
 */
const BARE_COUNT_PATTERN = /^[0-9]+\n?$/;

/**
 * The colour every invocation this checker makes carries. `render_slot_
 * sudoers.py` enumerates the read-only verb as `<slot> <colour>
 * email-batches` -- the same three-argument shape as `start`/`stop` -- but
 * the query itself is colour-blind (`branchleft_slot_wrapper.py`'s
 * `_data_directory`'s own doc comment: the colour pair shares one SQLite
 * file). Which literal is passed here is therefore arbitrary but fixed,
 * never derived from which colour is actually live, and never changes the
 * result.
 */
const FIXED_COLOUR: Colour = 'a';

/**
 * The real `EmailBatchChecker`: one sudo call per check, to the same
 * enumerated wrapper `wrapper.ts` already calls for `start`/`stop`/`reset`
 * (reusing its exact `command`/`prefix`/`timeoutMs` shape at the call
 * site is deliberate -- one wrapper, one config).
 *
 * **Fail-closed on everything, by construction, never by a caller
 * remembering to catch something.** A non-zero exit, a timeout, or stdout
 * that is not a bare count (`BARE_COUNT_PATTERN`) all resolve `true` --
 * "assume submitting" -- exactly like `createFailClosedEmailBatchChecker`'s
 * own unconditional default. Never throws: `attemptStopOldColour`
 * (`app.ts`) awaits this directly inside its own refusal check, and a
 * rejected promise there would crash the request instead of refusing it.
 */
export function createSudoEmailBatchChecker(
  config: SudoEmailBatchCheckerConfig,
  log?: (line: string) => void
): EmailBatchChecker {
  return {
    hasSubmittingBatch(slot: SlotName): Promise<boolean> {
      const argv = [...config.prefix, config.command, slot, FIXED_COLOUR, 'email-batches'];
      const [file, ...rest] = argv;
      if (!file) {
        log?.('email-batches check: wrapper command is empty -- failing closed');
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        execFile(file, rest, { timeout: config.timeoutMs }, (err, stdout, stderr) => {
          if (err) {
            log?.(`email-batches check failed for slot "${slot}": ${err.message} ${stderr}`.trim());
            resolve(true);
            return;
          }
          if (!BARE_COUNT_PATTERN.test(stdout)) {
            log?.(
              `email-batches check for slot "${slot}" returned unparseable output: ${JSON.stringify(stdout)}`
            );
            resolve(true);
            return;
          }
          resolve(Number.parseInt(stdout, 10) > 0);
        });
      });
    },
  };
}
