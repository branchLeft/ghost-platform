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
  /**
   * The enumerated `<slot> detach` verb: moves the slot's whole held set
   * (slot directory, content volume with its quarantine, data volume) into
   * the held area, seals, hashes and verifies it, and prints one receipt
   * line. Resolves to that receipt only once the wrapper itself exited 0 and
   * the line parses strictly; anything else rejects, and the broker then
   * keeps the slot `detaching`. It has its own, longer timeout
   * (`WrapperConfig.detachTimeoutMs`) because it hashes a whole tenancy.
   * See wrapper.md#slotwrapper-detach.
   */
  detach(slot: SlotName): Promise<DetachReceipt>;
}

/** What a confirmed detach hands back: the held entry's name, its manifest digest, its byte count. */
export interface DetachReceipt {
  /** `<slot>-<counter>`: the committed entry under the held root, never a `.partial`. */
  readonly entry: string;
  /** Lower-case hex SHA-256 over the entry's manifest. */
  readonly sha256: string;
  readonly bytes: number;
}

const RECEIPT_ENTRY = /^[a-z0-9][a-z0-9-]*-[0-9]+$/;
const RECEIPT_DIGEST = /^[0-9a-f]{64}$/;

/** True for exactly the receipt shape `detach` may print, and nothing looser. */
export function isDetachReceipt(value: unknown): value is DetachReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'bytes' || keys[1] !== 'entry' || keys[2] !== 'sha256') {
    return false;
  }
  const { entry, sha256, bytes } = value as Record<string, unknown>;
  return (
    typeof entry === 'string' &&
    RECEIPT_ENTRY.test(entry) &&
    typeof sha256 === 'string' &&
    RECEIPT_DIGEST.test(sha256) &&
    typeof bytes === 'number' &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0
  );
}

/** The wrapper exited 0 but did not print a receipt this code will accept. */
export class DetachReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DetachReceiptError';
  }
}

function parseDetachReceipt(stdout: string): DetachReceipt {
  const lines = stdout.split('\n').filter((line) => line !== '');
  if (lines.length !== 1) {
    throw new DetachReceiptError('detach did not print exactly one receipt line');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0] as string);
  } catch {
    throw new DetachReceiptError('detach receipt is not JSON');
  }
  if (!isDetachReceipt(parsed)) {
    throw new DetachReceiptError('detach receipt does not have the expected shape');
  }
  return { entry: parsed.entry, sha256: parsed.sha256, bytes: parsed.bytes };
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
  /** `detach` hashes a whole tenancy, so it is bounded on its own. Defaults to `timeoutMs`. */
  readonly detachTimeoutMs?: number;
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
  function run(args: readonly string[], timeoutMs: number = config.timeoutMs): Promise<string> {
    const argv = [...config.prefix, config.command, ...args];
    const [file, ...rest] = argv;
    if (!file) return Promise.reject(new Error('wrapper command is empty'));
    return new Promise((resolve, reject) => {
      execFile(file, rest, { timeout: timeoutMs }, (err, stdout, stderr) => {
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
    // Same two-element shape as `reset`: the slot, then the literal verb.
    detach: async (slot) =>
      parseDetachReceipt(
        await run([slot, 'detach' satisfies Verb], config.detachTimeoutMs ?? config.timeoutMs)
      ),
  };
}
