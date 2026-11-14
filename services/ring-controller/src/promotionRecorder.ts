import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { writeFileAtomic } from './atomicFile.js';
import {
  ChainRefusedError,
  createPromotionChainLog,
  verifyChain,
  type ChainHead,
  type PromotionRecord,
} from './promotionChainLog.js';
import { loadPublicKeyFile, loadSigningKeyFile } from './signingKeyFile.js';

/**
 * Appends to the promotion log and keeps the recorded head beside it. See
 * README.md in this directory for what the head file anchors and what it does
 * not.
 */

export const ENV_LOG_FILE = 'RING_CONTROLLER_PROMOTION_LOG_FILE';
export const ENV_HEAD_FILE = 'RING_CONTROLLER_PROMOTION_HEAD_FILE';
export const ENV_SIGNING_KEY_FILE = 'RING_CONTROLLER_RECORD_SIGNING_KEY_FILE';
export const ENV_PUBLIC_KEY_FILE = 'RING_CONTROLLER_RECORD_PUBLIC_KEY_FILE';

export type RecorderFailureCode =
  'head-malformed' | 'head-missing' | 'head-write-failed' | 'log-behind-head' | 'log-ahead-of-head';

/** The recorded head and the log do not agree, or the head could not be kept. */
export class PromotionRecorderError extends Error {
  readonly code: RecorderFailureCode;

  constructor(code: RecorderFailureCode) {
    super(`promotion recorder refused: ${code}`);
    this.name = 'PromotionRecorderError';
    this.code = code;
  }
}

/** A path variable is unset or not absolute. Names the variable, never a value. */
export class RecorderConfigError extends Error {
  constructor(readonly variable: string) {
    super(`promotion recorder: ${variable} must be set to an absolute path`);
    this.name = 'RecorderConfigError';
  }
}

export interface PromotionRecorderOptions {
  /** The promotion log file. */
  logPath: string;
  /** Where the last chain head is kept, written atomically after every append. */
  headPath: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  now: () => Date;
}

export interface PromotionRecorder {
  /**
   * Checks the log against the recorded head, appends one signed entry, then
   * records the new head. Throws, having recorded nothing further, when any
   * step fails. The caller must treat a throw as "this promotion is not
   * recorded".
   */
  record(record: PromotionRecord): Promise<void>;
  /** The same check without an append: the startup check. Returns the head, or null for an empty log. */
  check(): Promise<ChainHead | null>;
}

const HEAD_HASH = /^[0-9a-f]{64}$/;

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | undefined)?.code;
}

function serialiseHead(head: ChainHead): string {
  return JSON.stringify({ seq: head.seq, hash: head.hash }) + '\n';
}

function parseHead(text: string): ChainHead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PromotionRecorderError('head-malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PromotionRecorderError('head-malformed');
  }
  const { seq, hash } = value as Record<string, unknown>;
  if (
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof hash !== 'string' ||
    !HEAD_HASH.test(hash)
  ) {
    throw new PromotionRecorderError('head-malformed');
  }
  const head = { seq, hash };
  if (serialiseHead(head) !== text) throw new PromotionRecorderError('head-malformed');
  return head;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export function createPromotionRecorder(options: PromotionRecorderOptions): PromotionRecorder {
  const { logPath, headPath, publicKey } = options;
  const log = createPromotionChainLog({
    path: logPath,
    privateKey: options.privateKey,
    publicKey,
    now: options.now,
  });
  let tail: Promise<unknown> = Promise.resolve();

  async function writeHead(head: ChainHead): Promise<void> {
    try {
      await writeFileAtomic(headPath, serialiseHead(head));
    } catch {
      throw new PromotionRecorderError('head-write-failed');
    }
  }

  /**
   * The log must verify from its first byte and agree with the recorded head:
   * the entry at the recorded sequence number must still hash to the recorded
   * hash, and the log may be at most one entry longer (a crash between the
   * append and the head write, healed here). Shorter, rewritten, or further
   * ahead is refused.
   */
  async function reconcile(): Promise<ChainHead | null> {
    const text = (await readOptional(logPath)) ?? '';
    const whole = verifyChain(text, publicKey);
    if (!whole.ok) throw new ChainRefusedError(whole.code, whole.index);

    const headText = await readOptional(headPath);
    const recorded = headText === undefined ? undefined : parseHead(headText);
    const recordedLength = recorded === undefined ? 0 : recorded.seq + 1;
    if (whole.length < recordedLength) throw new PromotionRecorderError('log-behind-head');
    if (whole.length - recordedLength > 1) {
      throw new PromotionRecorderError(
        recorded === undefined ? 'head-missing' : 'log-ahead-of-head'
      );
    }
    if (recorded !== undefined) {
      const prefix = text.split('\n').slice(0, recordedLength).join('\n') + '\n';
      if (!verifyChain(prefix, publicKey, { head: recorded }).ok) {
        throw new PromotionRecorderError('log-behind-head');
      }
    }
    if (whole.head !== null && whole.length !== recordedLength) await writeHead(whole.head);
    return whole.head;
  }

  async function recordOne(record: PromotionRecord): Promise<void> {
    await reconcile();
    await log.append(record);
    const after = await log.verify();
    if (!after.ok) throw new ChainRefusedError(after.code, after.index);
    await writeHead(after.head as ChainHead);
  }

  return {
    record(record) {
      const run = tail.then(() => recordOne(record));
      tail = run.catch(() => undefined);
      return run;
    },
    check() {
      const run = tail.then(() => reconcile());
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

function requiredPath(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || !isAbsolute(value)) throw new RecorderConfigError(name);
  return value;
}

/**
 * Builds the recorder from the four path variables and the key files they
 * name. Nothing has a default: a missing variable or a refused key file stops
 * the controller before it promotes anything. `env` is passed in, never read
 * from the process.
 */
export async function createPromotionRecorderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  now: () => Date,
  keyOwnerUid?: number
): Promise<PromotionRecorder> {
  const logPath = requiredPath(env, ENV_LOG_FILE);
  const headPath = requiredPath(env, ENV_HEAD_FILE);
  const signingKeyPath = requiredPath(env, ENV_SIGNING_KEY_FILE);
  const publicKeyPath = requiredPath(env, ENV_PUBLIC_KEY_FILE);
  const privateKey = await loadSigningKeyFile(
    signingKeyPath,
    keyOwnerUid === undefined ? {} : { ownerUid: keyOwnerUid }
  );
  const publicKey = await loadPublicKeyFile(publicKeyPath);
  return createPromotionRecorder({ logPath, headPath, privateKey, publicKey, now });
}
