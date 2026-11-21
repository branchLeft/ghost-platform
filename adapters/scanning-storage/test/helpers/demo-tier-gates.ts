// The demo tier's refusal, hold and age gates, written once as assertions that
// run through the real entry adapter, the real decorator, the real unix-socket
// transport and the real host end, with a stand-in for the safety service on
// the inbound side. demo-tier-gates.md says what each assertion proves and
// what is substituted. Every assertion is a `must(id, ...)` call: a failed one
// throws a GateFailure naming its id, and the registry records which ids have
// passed and which have been seen red, so a test can require every id to have
// both.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeStorageBase } from './fake-storage-base.mjs';
import { FakeWrappedAdapter } from './fake-wrapped-adapter.mjs';
import { hashOf, startRig, verdictFor } from './verdict-host-rig.mjs';

const require = createRequire(import.meta.url);

export const ASSERTION_IDS = [
  'refusal.upload-refused',
  'refusal.nothing-served',
  'refusal.nothing-stored',
  'hold.upload-accepted',
  'hold.original-not-served',
  'hold.size-request-empty',
  'hold.stays-withheld',
  'hold.promoted-on-clean-verdict',
  'age.grows-while-undrained',
  'age.carries-across-restart',
  'age.returns-to-zero',
] as const;
export type AssertionId = (typeof ASSERTION_IDS)[number];

export const registry = { passed: new Set<AssertionId>(), red: new Set<AssertionId>() };

export class GateFailure extends Error {
  readonly assertion: AssertionId;
  constructor(assertion: AssertionId, detail: string) {
    super(`${assertion}: ${detail}`);
    this.name = 'GateFailure';
    this.assertion = assertion;
  }
}

function must(id: AssertionId, ok: boolean, detail: string): void {
  if (!ok) {
    registry.red.add(id);
    throw new GateFailure(id, detail);
  }
  registry.passed.add(id);
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += 20) {
    if (await check()) return true;
    await wait(20);
  }
  return false;
}

// The three synthetic fixtures. None is a real image of anything: the bytes
// only need to be distinct and stable. Which one the safety service treats as
// the test classification is the service stand-in's choice, as the real
// service's is a hash it holds.
export const FIXTURES = {
  testClassification: Buffer.from('synthetic-fixture:test-classification'),
  clean: Buffer.from('synthetic-fixture:clean'),
  other: Buffer.from('synthetic-fixture:other'),
};

// The adapter's hash stage today is a SHA-256 hex stand-in, which the host end
// refuses on sight (it carries only a 32-byte perceptual-hash key). Until the
// adapter computes a real one, the harness swaps that one function for a map
// from each fixture to a key of the right shape. Nothing else is swapped.
const FIXTURE_KEYS = new Map<string, string>([
  [FIXTURES.testClassification.toString('hex'), hashOf(11)],
  [FIXTURES.clean.toString('hex'), hashOf(12)],
  [FIXTURES.other.toString('hex'), hashOf(13)],
]);
export const keyOf = (bytes: Buffer): string => FIXTURE_KEYS.get(bytes.toString('hex')) ?? '';

export interface EntryAdapterInstance {
  wrapped: FakeWrappedAdapter;
  hold: { isPending(key: string): boolean };
  save(file: { name: string; path: string; type: string }, dir?: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Buffer>;
  urlToPath(url: string): string;
}
type EntryAdapterClass = new (config: Record<string, unknown>) => EntryAdapterInstance;

export interface Loaded {
  Entry: EntryAdapterClass;
  restore(): void;
}

// Loads Ghost's entry file with the two things Ghost's image would supply
// resolved to the suite's doubles (the storage base class and the wrapped
// local adapter) and the hash stage substituted as described above. `alsoWraps`
// names further adapters a slot may wrap by name (the tenant tier's
// `S3Storage` double, see tenant-tier-gates.md).
export function loadEntryAdapter(srcDir: string, alsoWraps: Record<string, unknown> = {}): Loaded {
  const NodeModule = require('node:module');
  const originalLoad = NodeModule._load;
  const wrappedPath = path.join(srcDir, 'FakeAdapter');
  NodeModule._load = function patchedLoad(request: string, ...rest: unknown[]) {
    if (request === 'ghost-storage-base') return { StorageBase: FakeStorageBase };
    if (request === wrappedPath) return FakeWrappedAdapter;
    for (const [name, adapterClass] of Object.entries(alsoWraps)) {
      if (request === path.join(srcDir, name)) return adapterClass;
    }
    return originalLoad.call(this, request, ...rest);
  };
  const pdq = require(path.join(srcDir, 'pdq.js'));
  const originalDigest = pdq.digestBytes;
  pdq.digestBytes = (bytes: Buffer) => keyOf(bytes) || originalDigest(bytes);
  const entryFile = path.join(srcDir, 'ScanningStorageAdapter.js');
  delete require.cache[entryFile];
  const Entry = require(entryFile) as EntryAdapterClass;
  return {
    Entry,
    restore() {
      NodeModule._load = originalLoad;
      pdq.digestBytes = originalDigest;
      delete require.cache[entryFile];
    },
  };
}

type RigHandle = Awaited<ReturnType<typeof startRig>>;

// The verdict channel's host end, which a gate can stop and start again over
// the same directory (so the journal, and with it the age of a waiting hash,
// carries across). One clock, moved by the gates, runs every host it starts.
export class Channel {
  rig: RigHandle | null = null;
  readonly directory: string;
  private readonly clock: { now(): number; advance(ms: number): void };

  private constructor(directory: string, clock: Channel['clock']) {
    this.directory = directory;
    this.clock = clock;
  }

  static async start(): Promise<Channel> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-'));
    let offset = 0;
    const channel = new Channel(directory, {
      now: () => Date.now() + offset,
      advance: (ms) => {
        offset += ms;
      },
    });
    await channel.restart();
    return channel;
  }

  get socketPath(): string {
    return path.join(this.directory, 'v.sock');
  }

  advance(ms: number): void {
    this.clock.advance(ms);
  }

  async stop(): Promise<void> {
    await this.rig?.stop();
    this.rig = null;
  }

  async restart(): Promise<void> {
    await this.stop();
    this.rig = await startRig({
      directory: this.directory,
      clock: this.clock,
      config: { askWaitMs: 150, holdMs: 100 },
    });
  }

  get up(): RigHandle {
    if (this.rig === null) throw new Error('the host end is stopped');
    return this.rig;
  }

  oldestAgeSeconds(): number {
    const text: string = this.up.host.metrics.render();
    const match = /^verdict_host_oldest_unverdicted_age_seconds (\S+)$/m.exec(text);
    return match ? Number(match[1]) : Number.NaN;
  }

  async cleanup(): Promise<void> {
    await this.rig?.stop().catch(() => {});
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}

type Answer = { classification: string; decision: Record<string, unknown> };
const ALLOW: Answer = { classification: 'no-known-match', decision: { action: 'allow' } };
const REFUSE_TEST: Answer = {
  classification: 'test',
  decision: {
    action: 'refuse',
    tier: 'two',
    irreversible: false,
    control: true,
    steps: ['withhold'],
  },
};

// The safety service's side: it dials in, takes what is queued, and answers
// each hash from `answers` (anything not listed is clean). Nothing happens
// unless a gate calls `drain`, so "the service is not draining" is the default.
export class StandInService {
  constructor(
    private readonly channel: Channel,
    private readonly answers: Map<string, Answer> = new Map()
  ) {}

  refuse(key: string): void {
    this.answers.set(key, REFUSE_TEST);
  }

  // Polls until `key` is offered, then answers the whole batch. False when it
  // was never offered within the time.
  async drain(key: string, timeoutMs = 4000): Promise<boolean> {
    for (let waited = 0; waited <= timeoutMs;) {
      const started = Date.now();
      const rig = this.channel.up;
      const { batch, hashes } = (await rig.poll()) as { batch: string; hashes: string[] };
      if (hashes.includes(key)) {
        const verdicts = hashes.map((hash: string) =>
          verdictFor(hash, this.answers.get(hash) ?? ALLOW)
        );
        return (await rig.post(batch, verdicts)).status === 204;
      }
      if (hashes.length > 0) {
        await rig.post(batch, []);
      }
      waited += Date.now() - started + 1;
    }
    return false;
  }
}

const TARGET_DIR = '2026/11/';

export interface Outcome {
  accepted: boolean;
  status: number;
  path: string | null;
}

// One demo slot's storage, as Ghost sees it. `source` picks how the decorator
// is told to find verdicts: over the channel (what a demo runs) or, for the
// controls, an allow-everything in-process source or none at all.
export class Slot {
  readonly adapter: EntryAdapterInstance;
  private readonly scratch: string;
  readonly paths: string[] = [];

  private constructor(adapter: EntryAdapterInstance, scratch: string) {
    this.adapter = adapter;
    this.scratch = scratch;
  }

  static async build(
    loaded: Loaded,
    source: { kind: 'channel'; channel: Channel } | { kind: 'allow-all' } | { kind: 'none' }
  ): Promise<Slot> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-'));
    const verdictConfig =
      source.kind === 'channel'
        ? { verdictSource: 'production', verdictSocketPath: source.channel.socketPath }
        : source.kind === 'allow-all'
          ? { verdictSource: 'in-process-fake' }
          : {};
    const adapter = new loaded.Entry({
      tier: 'demo',
      wraps: 'FakeAdapter',
      wrappedConfig: { storagePath: 'wrapped' },
      quarantinePath: path.join(scratch, 'quarantine'),
      holdRetryMs: 20,
      holdLogger: { error: () => {} },
      verdictConnectTimeoutMs: '200',
      verdictTotalTimeoutMs: '1500',
      ...verdictConfig,
    });
    return new Slot(adapter, scratch);
  }

  async upload(name: string, bytes: Buffer): Promise<Outcome> {
    const file = path.join(this.scratch, `up-${crypto.randomBytes(4).toString('hex')}`);
    await fs.writeFile(file, bytes);
    try {
      const url = await this.adapter.save(
        { name, path: file, type: 'image/png' },
        TARGET_DIR.slice(0, -1)
      );
      // The path under the wrapped adapter's root, which is where the file
      // lands when it is written (the URL is Ghost's public one).
      const stored = url.slice(url.indexOf(TARGET_DIR));
      this.paths.push(stored);
      return { accepted: true, status: 201, path: stored };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      return { accepted: false, status, path: null };
    }
  }

  serves(storedPath: string): Promise<boolean> {
    return this.adapter.exists(storedPath);
  }

  // Ghost's responsive-size route: a derivative already on disk is served; else
  // the original is read, resized and written, and that is served. With no
  // original there is nothing to resize and nothing comes back.
  async sizeRequest(storedPath: string): Promise<Buffer | null> {
    const sized = `size/w600/${storedPath}`;
    if (await this.adapter.exists(sized)) return this.adapter.read(sized);
    if (!(await this.adapter.exists(storedPath))) return null;
    const original = await this.adapter.read(storedPath);
    await this.adapter.wrapped.saveRaw(original, sized);
    return original;
  }

  storedFiles(): string[] {
    return [...this.adapter.wrapped.files.keys()];
  }

  async cleanup(): Promise<void> {
    await fs.rm(this.scratch, { recursive: true, force: true });
  }
}

export type Interfere = (phase: string) => Promise<void> | void;
const noInterference: Interfere = () => {};

const servedAnywhere = async (slot: Slot): Promise<string[]> => {
  const served: string[] = [];
  for (const storedPath of slot.paths) {
    if ((await slot.serves(storedPath)) || (await slot.sizeRequest(storedPath)) !== null) {
      served.push(storedPath);
    }
  }
  return served;
};

// Refusal. The hash is first offered to the service (the upload is held, as
// any unknown hash is), the service answers it as a match, and the next
// upload of the same bytes must be refused with the typed 415. Nothing about
// the bytes may ever be served or stored.
export async function assertRefusal(
  slot: Slot,
  service: StandInService,
  bytes: Buffer,
  interfere: Interfere = noInterference
): Promise<void> {
  const key = keyOf(bytes);
  const first = await slot.upload('first.png', bytes);
  if (first.accepted) await service.drain(key, 1500);
  await until(() => !slot.adapter.hold.isPending(key), 4000);
  await interfere('after-answer');

  const second = await slot.upload('second.png', bytes);
  must(
    'refusal.upload-refused',
    !second.accepted && second.status === 415,
    `the second upload gave status ${second.status}, accepted=${second.accepted}`
  );
  const served = await servedAnywhere(slot);
  must('refusal.nothing-served', served.length === 0, `served: ${served.join(', ')}`);
  must(
    'refusal.nothing-stored',
    slot.storedFiles().length === 0,
    `stored: ${slot.storedFiles().join(', ')}`
  );
}

// Hold. With the safety service not draining, an upload is accepted and a URL
// is returned; the URL serves nothing, a size request returns nothing and
// writes no derivative, and that stays true across several retry rounds.
export async function assertHold(
  slot: Slot,
  bytes: Buffer,
  interfere: Interfere = noInterference
): Promise<string> {
  const upload = await slot.upload('held.png', bytes);
  must(
    'hold.upload-accepted',
    upload.accepted && upload.path !== null,
    `the upload gave status ${upload.status}`
  );
  const stored = upload.path as string;
  await interfere('after-upload');

  must('hold.original-not-served', !(await slot.serves(stored)), 'the original is served');
  const sized = await slot.sizeRequest(stored);
  const derivatives = slot.storedFiles().filter((file) => file.startsWith('size/'));
  must(
    'hold.size-request-empty',
    sized === null && derivatives.length === 0,
    `size request gave ${sized === null ? 'nothing' : 'bytes'}, derivatives: ${derivatives.length}`
  );

  await wait(500);
  await interfere('after-retries');
  const still = await servedAnywhere(slot);
  must('hold.stays-withheld', still.length === 0, `served after retries: ${still.join(', ')}`);
  return stored;
}

// Promotion. Once the service answers clean, the same size request returns the
// image. `timeoutMs` bounds the wait so a control that never answers is quick.
export async function assertPromotion(
  slot: Slot,
  service: StandInService,
  bytes: Buffer,
  stored: string,
  { drain = true, timeoutMs = 5000 } = {}
): Promise<void> {
  if (drain) await service.drain(keyOf(bytes));
  const got: { image: Buffer | null } = { image: null };
  await until(async () => {
    got.image = await slot.sizeRequest(stored);
    return got.image !== null;
  }, timeoutMs);
  const { image } = got;
  must(
    'hold.promoted-on-clean-verdict',
    image !== null && image.equals(bytes),
    'the size request did not return the image after a clean verdict'
  );
}

// Age. The producer-side age of the oldest unverdicted hash grows while the
// service is not draining, survives a restart of the host end, and is zero
// again once the verdict is in.
export async function assertAge(
  slot: Slot,
  channel: Channel,
  service: StandInService,
  bytes: Buffer,
  interfere: Interfere = noInterference
): Promise<void> {
  await slot.upload('aged.png', bytes);
  channel.advance(120_000);
  const early = channel.oldestAgeSeconds();
  channel.advance(60_000);
  const later = channel.oldestAgeSeconds();
  must(
    'age.grows-while-undrained',
    early >= 120 && later - early >= 59,
    `age read ${early} then ${later}`
  );

  await interfere('before-restart');
  await channel.restart();
  const restarted = channel.oldestAgeSeconds();
  must('age.carries-across-restart', restarted >= later, `age was ${later}, read ${restarted}`);

  await service.drain(keyOf(bytes));
  await interfere('before-zero');
  const settled = channel.oldestAgeSeconds();
  must('age.returns-to-zero', settled === 0, `age read ${settled} after the verdict`);
}
