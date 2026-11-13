import { createHash, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { syncDirectory } from './atomicFile.js';

/**
 * The controller's own record of every slot promotion: an append-only file of
 * signed entries, each carrying the hash of the one before. See README.md in
 * this directory for the format, what it detects and what it cannot.
 */

export const CHAIN_VERSION = 1;
/** The `prev` of the first entry: sixty-four zeros, no entry before it. */
export const GENESIS_HASH = '0'.repeat(64);
const SIGNING_DOMAIN = 'branchleft.promotion-chain.v1\n';

const NAME = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/** What the controller records for one slot of one promotion. */
export interface PromotionRecord {
  /** Names the promotion (one release walking the rings). */
  promotion: string;
  /** The slot that took the release. */
  slot: string;
  /** The released image digest, `sha256:` and 64 lowercase hex digits. */
  digest: string;
}

export interface ChainEntry extends PromotionRecord {
  version: typeof CHAIN_VERSION;
  /** Zero for the first entry, then one more each time. */
  seq: number;
  /** UTC, millisecond precision, `Z`. */
  at: string;
  /** The SHA-256 of the previous entry's exact line, or `GENESIS_HASH`. */
  prev: string;
  /** Base64 Ed25519 signature over the signed fields (everything but this). */
  signature: string;
}

export interface ChainHead {
  seq: number;
  /** The SHA-256 of the last entry's exact line. */
  hash: string;
}

export type ChainFailureCode =
  | 'unreadable-line'
  | 'torn-final-line'
  | 'malformed-entry'
  | 'non-canonical-entry'
  | 'sequence-break'
  | 'chain-break'
  | 'bad-signature'
  | 'duplicate-slot-promotion'
  | 'head-mismatch';

export type ChainVerification =
  | { ok: true; length: number; head: ChainHead | null }
  | { ok: false; code: ChainFailureCode; index: number };

export class ChainRefusedError extends Error {
  readonly code: ChainFailureCode | 'bad-record' | 'bad-key' | 'signer-key-mismatch';
  readonly index: number | null;

  constructor(code: ChainRefusedError['code'], index: number | null = null) {
    super(`promotion chain refused: ${code}${index === null ? '' : ` at entry ${index}`}`);
    this.name = 'ChainRefusedError';
    this.code = code;
    this.index = index;
  }
}

export interface PromotionChainLogOptions {
  /** The log file. Created on the first append, mode 0600. */
  path: string;
  /** The record-signing private key (Ed25519). Used only to sign. */
  privateKey: KeyObject;
  /** The committed public half of the same key (Ed25519). Used to verify. */
  publicKey: KeyObject;
  /** Injected so a test drives time. */
  now: () => Date;
}

export interface PromotionChainLog {
  /**
   * Verifies the whole file, then appends one signed entry. Refuses, writing
   * nothing, when the file does not verify, the record is malformed, the slot
   * already has an entry for this promotion, or the signer does not match the
   * public key.
   */
  append(record: PromotionRecord): Promise<ChainEntry>;
  /** Verifies the file from its first byte. A missing file is an empty, valid chain. */
  verify(expected?: { head: ChainHead }): Promise<ChainVerification>;
}

function assertEd25519(key: KeyObject, kind: 'private' | 'public'): void {
  if (key.type !== kind || key.asymmetricKeyType !== 'ed25519') {
    throw new ChainRefusedError('bad-key');
  }
}

function hashLine(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

function signedMessage(entry: Omit<ChainEntry, 'signature'>): Buffer {
  const fields = [
    entry.version,
    entry.seq,
    entry.at,
    entry.promotion,
    entry.slot,
    entry.digest,
    entry.prev,
  ];
  return Buffer.from(SIGNING_DOMAIN + JSON.stringify(fields), 'utf8');
}

/** The one serialisation: fixed key order, no whitespace. */
function serialise(entry: ChainEntry): string {
  return JSON.stringify({
    version: entry.version,
    seq: entry.seq,
    at: entry.at,
    promotion: entry.promotion,
    slot: entry.slot,
    digest: entry.digest,
    prev: entry.prev,
    signature: entry.signature,
  });
}

const ENTRY_KEYS = [
  'version',
  'seq',
  'at',
  'promotion',
  'slot',
  'digest',
  'prev',
  'signature',
] as const;

function parseEntry(line: string): ChainEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ENTRY_KEYS.length || !ENTRY_KEYS.every((key) => keys.includes(key))) {
    return null;
  }
  const { version, seq, at, promotion, slot, digest, prev, signature } = record;
  if (version !== CHAIN_VERSION) return null;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (typeof at !== 'string' || !TIMESTAMP.test(at)) return null;
  if (typeof promotion !== 'string' || !NAME.test(promotion)) return null;
  if (typeof slot !== 'string' || !NAME.test(slot)) return null;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) return null;
  if (typeof prev !== 'string' || !HASH.test(prev)) return null;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return null;
  return { version, seq, at, promotion, slot, digest, prev, signature };
}

function checkRecord(record: PromotionRecord): void {
  if (!NAME.test(record.promotion) || !NAME.test(record.slot) || !DIGEST.test(record.digest)) {
    throw new ChainRefusedError('bad-record');
  }
}

type Scan =
  | { ok: true; entries: ChainEntry[]; lines: string[]; head: ChainHead | null }
  | { ok: false; code: ChainFailureCode; index: number };

function scanChain(text: string, publicKey: KeyObject): Scan {
  assertEd25519(publicKey, 'public');
  if (text === '') return { ok: true, entries: [], lines: [], head: null };
  const lines = text.split('\n');
  const last = lines.pop();
  if (last !== '') return { ok: false, code: 'torn-final-line', index: lines.length };

  let prev = GENESIS_HASH;
  let head: ChainHead | null = null;
  const entries: ChainEntry[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const entry = parseEntry(line);
    if (entry === null) return { ok: false, code: 'malformed-entry', index };
    if (serialise(entry) !== line) return { ok: false, code: 'non-canonical-entry', index };
    if (entry.seq !== index) return { ok: false, code: 'sequence-break', index };
    if (entry.prev !== prev) return { ok: false, code: 'chain-break', index };
    const signature = Buffer.from(entry.signature, 'base64');
    if (!verify(null, signedMessage(entry), publicKey, signature)) {
      return { ok: false, code: 'bad-signature', index };
    }
    const pair = `${entry.promotion}\n${entry.slot}`;
    if (seen.has(pair)) return { ok: false, code: 'duplicate-slot-promotion', index };
    seen.add(pair);
    prev = hashLine(line);
    head = { seq: entry.seq, hash: prev };
    entries.push(entry);
  }
  return { ok: true, entries, lines, head };
}

/** Verifies the text of a log, entry by entry, from the first byte. */
export function verifyChain(
  text: string,
  publicKey: KeyObject,
  expected?: { head: ChainHead }
): ChainVerification {
  const scan = scanChain(text, publicKey);
  if (!scan.ok) return scan;
  const { head, lines } = scan;
  if (
    expected !== undefined &&
    (head === null || head.hash !== expected.head.hash || head.seq !== expected.head.seq)
  ) {
    return { ok: false, code: 'head-mismatch', index: lines.length };
  }
  return { ok: true, length: lines.length, head };
}

async function readLog(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return '';
    throw error;
  }
}

export function createPromotionChainLog(options: PromotionChainLogOptions): PromotionChainLog {
  assertEd25519(options.privateKey, 'private');
  assertEd25519(options.publicKey, 'public');
  const { path, privateKey, publicKey, now } = options;
  // One append at a time inside this process; the process lock keeps it to one process.
  let tail: Promise<unknown> = Promise.resolve();

  async function appendOne(record: PromotionRecord): Promise<ChainEntry> {
    checkRecord(record);
    const text = await readLog(path);
    const scan = scanChain(text, publicKey);
    if (!scan.ok) throw new ChainRefusedError(scan.code, scan.index);
    if (scan.entries.some((e) => e.promotion === record.promotion && e.slot === record.slot)) {
      throw new ChainRefusedError('duplicate-slot-promotion', scan.entries.length);
    }

    const previousLine = scan.lines[scan.lines.length - 1];
    const unsigned = {
      version: CHAIN_VERSION,
      seq: scan.lines.length,
      at: now().toISOString(),
      promotion: record.promotion,
      slot: record.slot,
      digest: record.digest,
      prev: previousLine === undefined ? GENESIS_HASH : hashLine(previousLine),
    } as const;
    const message = signedMessage(unsigned);
    const signature = sign(null, message, privateKey);
    if (!verify(null, message, publicKey, signature)) {
      throw new ChainRefusedError('signer-key-mismatch', scan.lines.length);
    }
    const line = serialise({ ...unsigned, signature: signature.toString('base64') });

    const created = text === '';
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.appendFile(line + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (created) await syncDirectory(dirname(path));
    return { ...unsigned, signature: signature.toString('base64') };
  }

  return {
    append(record) {
      const run = tail.then(() => appendOne(record));
      tail = run.catch(() => undefined);
      return run;
    },
    async verify(expected) {
      return verifyChain(await readLog(path), publicKey, expected);
    },
  };
}
