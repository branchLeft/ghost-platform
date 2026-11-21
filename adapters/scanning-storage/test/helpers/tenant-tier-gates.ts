// The tenant tier's refusal and hold gates, written once as assertions that run
// through the real entry adapter, the real decorator, the real unix-socket
// transport and the real host end, with the decorator wrapping an object-store
// adapter (the shape of Ghost's S3Storage) over a bucket the gates can read
// directly. tenant-tier-gates.md says what each assertion proves, what is
// substituted, and what a run on a live tenant slot needs. Every assertion is a
// `must(id, ...)` call: a failed one throws a TenantGateFailure naming its id,
// and the registry records which ids have passed and which have been seen red,
// so a test can require every id to have both.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeStorageBase } from './fake-storage-base.mjs';
import {
  Channel,
  FIXTURES,
  GateFailure,
  digestOf,
  keyOf,
  until,
  wait,
  assertRefusal as assertDemoRefusal,
  type Loaded,
  type Slot as DemoSlot,
  type StandInService,
} from './demo-tier-gates';

export const TENANT_ASSERTION_IDS = [
  'refusal.upload-refused',
  'refusal.nothing-served',
  'refusal.not-in-bucket',
  'hold.upload-accepted',
  'hold.original-not-served',
  'hold.size-request-empty',
  'hold.absent-from-bucket',
  'hold.stays-withheld',
  'promotion.present-in-bucket',
  'promotion.served',
  'pair.demo-tier-refuses',
  'age.grows-while-undrained',
  'age.returns-to-zero',
] as const;
export type TenantAssertionId = (typeof TENANT_ASSERTION_IDS)[number];

export const tenantRegistry = {
  passed: new Set<TenantAssertionId>(),
  red: new Set<TenantAssertionId>(),
};

export class TenantGateFailure extends Error {
  readonly assertion: TenantAssertionId;
  constructor(assertion: TenantAssertionId, detail: string) {
    super(`${assertion}: ${detail}`);
    this.name = 'TenantGateFailure';
    this.assertion = assertion;
  }
}

function must(id: TenantAssertionId, ok: boolean, detail: string): void {
  if (!ok) {
    tenantRegistry.red.add(id);
    throw new TenantGateFailure(id, detail);
  }
  tenantRegistry.passed.add(id);
}

// The two paid tiers. Both run the object store (D55); the gates are the same.
export const PAID_TIERS = ['entry', 'professional'] as const;
export type PaidTier = (typeof PAID_TIERS)[number];

// What a run reads the bucket through. Direct means not through the decorator
// and not through Ghost: the in-process bucket answers from its own state, and
// a live bucket is read with its own S3 credential (a GET, a listing and a
// version listing). `everWritten` is true when the key has ever held an
// object, so a key written and then deleted or hidden counts: absence in the
// gates means never written, not unlinked.
export interface BucketView {
  read(key: string): Promise<Buffer | null>;
  keys(): Promise<string[]>;
  everWritten(key: string): Promise<boolean>;
}

type S3CommandKind = 'PutObject' | 'GetObject' | 'HeadObject' | 'DeleteObject';
export interface S3Input {
  Bucket: string;
  Key: string;
  Body?: Buffer;
  ContentType?: string;
}
export class S3Command {
  constructor(
    readonly kind: S3CommandKind,
    readonly input: S3Input
  ) {}
}

function notFound(): Error {
  return Object.assign(new Error('NotFound'), { name: 'NotFound', statusCode: 404 });
}

// The bucket behind the double. It answers the calls Ghost's S3Storage makes
// and refuses a delete, as the signing gateway in front of the real bucket
// does, so nothing is ever unlinked: a key either was written or was not. Every
// write is kept in `writes`, whether or not the object is later readable.
export class MemoryBucket implements BucketView {
  private readonly objects = new Map<string, Buffer>();
  readonly writes: { key: string; bytes: Buffer }[] = [];

  async send(command: S3Command): Promise<{ Body?: Buffer }> {
    const { Key, Body } = command.input;
    switch (command.kind) {
      case 'PutObject':
        this.plant(Key, Body ?? Buffer.alloc(0));
        return {};
      case 'HeadObject':
        if (!this.objects.has(Key)) throw notFound();
        return {};
      case 'GetObject': {
        const found = this.objects.get(Key);
        if (found === undefined) throw notFound();
        return { Body: found };
      }
      case 'DeleteObject':
        throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', statusCode: 403 });
    }
  }

  // A write that does not go through the adapter: what a control uses to put
  // bytes into the bucket the way a bug or an attacker would.
  plant(key: string, bytes: Buffer): void {
    this.objects.set(key, Buffer.from(bytes));
    this.writes.push({ key, bytes: Buffer.from(bytes) });
  }

  async read(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null;
  }

  async keys(): Promise<string[]> {
    return [...this.objects.keys()].sort();
  }

  async everWritten(key: string): Promise<boolean> {
    return this.writes.some((write) => write.key === key);
  }
}

// Ghost's S3Storage as the decorator meets it: every write is a command sent
// through `client`, `save` names a content type and `saveRaw` names none, a
// key is the target path as given, and nothing is written until it is asked
// to. `maskReads` is the control's: it answers `exists` false and `read` not
// found whatever the bucket holds, which is what an adapter that wrote and
// then hid an object would look like from outside.
export class S3ShapedStorage extends FakeStorageBase {
  readonly client: MemoryBucket;
  readonly storagePath: string;
  readonly staticFileURLPrefix: string;
  private readonly bucketName: string;
  private readonly cdnUrl: string;
  private readonly maskReads: boolean;

  constructor(config: Record<string, unknown> = {}) {
    super();
    this.client = config.bucketDouble as MemoryBucket;
    this.bucketName = String(config.bucket);
    this.cdnUrl = String(config.cdnUrl).replace(/\/$/, '');
    this.storagePath = String(config.storagePath ?? 'content/images');
    this.staticFileURLPrefix = this.storagePath;
    this.maskReads = config.maskReads === true;
  }

  getTargetDir(baseDir: string): string {
    return `${baseDir}/2026/11`;
  }

  private key(fileName: string, targetDir?: string): string {
    return (targetDir ? `${targetDir}/${fileName}` : fileName).replace(/^\/+/, '');
  }

  async exists(fileName: string, targetDir?: string): Promise<boolean> {
    if (this.maskReads) return false;
    try {
      await this.client.send(
        new S3Command('HeadObject', { Bucket: this.bucketName, Key: this.key(fileName, targetDir) })
      );
      return true;
    } catch {
      return false;
    }
  }

  async save(
    file: { name: string; path: string; type: string },
    targetDir?: string
  ): Promise<string> {
    const key = this.key(file.name, targetDir ?? this.getTargetDir(this.storagePath));
    await this.client.send(
      new S3Command('PutObject', {
        Bucket: this.bucketName,
        Key: key,
        Body: await fs.readFile(file.path),
        ContentType: file.type,
      })
    );
    return `${this.cdnUrl}/${key}`;
  }

  async saveRaw(buffer: Buffer, targetPath: string): Promise<string> {
    const key = this.key(targetPath);
    await this.client.send(
      new S3Command('PutObject', { Bucket: this.bucketName, Key: key, Body: buffer })
    );
    return `${this.cdnUrl}/${key}`;
  }

  async read(options: string | { path: string }): Promise<Buffer> {
    const key = this.key(typeof options === 'object' ? options.path : options);
    if (this.maskReads) throw notFound();
    const got = await this.client.send(
      new S3Command('GetObject', { Bucket: this.bucketName, Key: key })
    );
    return got.Body as Buffer;
  }

  async delete(fileName: string, targetDir?: string): Promise<void> {
    await this.client.send(
      new S3Command('DeleteObject', { Bucket: this.bucketName, Key: this.key(fileName, targetDir) })
    );
  }

  urlToPath(url: string): string {
    return url.replace(`${this.cdnUrl}/`, '');
  }

  serve(): () => void {
    return () => {};
  }
}

export const TENANT_ADAPTERS = { S3Storage: S3ShapedStorage };

const TARGET_DIR = 'content/images/2026/11';
const STORAGE_ROOT = 'content/images/';

export interface Outcome {
  accepted: boolean;
  status: number;
  key: string | null;
}

// What a gate needs of a tenant slot. The in-process slot below implements it;
// a run on the live slot implements it over Ghost's admin upload, an anonymous
// read of the public URL and a direct read of the bucket with its own
// credential (tenant-tier-gates.md, "Running it on a live slot").
export interface TenantSurface {
  readonly bucket: BucketView;
  upload(name: string, bytes: Buffer): Promise<Outcome>;
  serves(key: string): Promise<boolean>;
  sizeRequest(key: string): Promise<Buffer | null>;
  // True once no verdict is pending for these bytes (an answer has been acted on).
  settled(bytes: Buffer): Promise<boolean>;
  uploadedKeys(): string[];
}

interface TenantEntryInstance {
  hold: { isPending(key: string): boolean };
  wrapped: S3ShapedStorage;
  save(file: { name: string; path: string; type: string }, dir?: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Buffer>;
}
type TenantEntryClass = new (config: Record<string, unknown>) => TenantEntryInstance;

export type TenantSource =
  { kind: 'channel'; channel: Channel } | { kind: 'allow-all' } | { kind: 'none' };

export interface TenantSlotOptions {
  tier: PaidTier;
  maskReads?: boolean;
}

// One tenant slot's storage, as Ghost sees it: the real entry adapter wrapping
// the object-store double over its own bucket.
export class TenantSlot implements TenantSurface {
  readonly adapter: TenantEntryInstance;
  readonly bucket: MemoryBucket;
  private readonly scratch: string;
  private readonly keys: string[] = [];

  private constructor(adapter: TenantEntryInstance, bucket: MemoryBucket, scratch: string) {
    this.adapter = adapter;
    this.bucket = bucket;
    this.scratch = scratch;
  }

  static async build(
    loaded: Loaded,
    source: TenantSource,
    options: TenantSlotOptions
  ): Promise<TenantSlot> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-'));
    const bucket = new MemoryBucket();
    const verdictConfig =
      source.kind === 'channel'
        ? { verdictSource: 'production', verdictSocketPath: source.channel.socketPath }
        : source.kind === 'allow-all'
          ? { verdictSource: 'in-process-fake' }
          : {};
    const Entry = loaded.Entry as unknown as TenantEntryClass;
    const adapter = new Entry({
      tier: options.tier,
      wraps: 'S3Storage',
      wrappedConfig: {
        bucket: 'tenant-media',
        region: 'test',
        endpoint: 'https://objects.example.test',
        cdnUrl: 'https://objects.example.test/tenant-media',
        storagePath: 'content/images',
        bucketDouble: bucket,
        maskReads: options.maskReads === true,
      },
      quarantinePath: path.join(scratch, 'quarantine'),
      holdRetryMs: 20,
      holdLogger: { error: () => {} },
      verdictConnectTimeoutMs: '200',
      verdictTotalTimeoutMs: '1500',
      ...verdictConfig,
    });
    return new TenantSlot(adapter, bucket, scratch);
  }

  async upload(name: string, bytes: Buffer): Promise<Outcome> {
    const file = path.join(this.scratch, `up-${crypto.randomBytes(4).toString('hex')}`);
    await fs.writeFile(file, bytes);
    try {
      const url = await this.adapter.save({ name, path: file, type: 'image/png' }, TARGET_DIR);
      const key = this.adapter.wrapped.urlToPath(url);
      this.keys.push(key);
      return { accepted: true, status: 201, key };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      return { accepted: false, status, key: null };
    }
  }

  serves(key: string): Promise<boolean> {
    return this.adapter.exists(key);
  }

  // Ghost's responsive-size route: a derivative already in the bucket is served;
  // else the original is read, resized and written, and that is served. With no
  // original there is nothing to resize and nothing comes back.
  async sizeRequest(key: string): Promise<Buffer | null> {
    const sized = `${STORAGE_ROOT}size/w600/${key.slice(STORAGE_ROOT.length)}`;
    if (await this.adapter.exists(sized)) return this.adapter.read(sized);
    if (!(await this.adapter.exists(key))) return null;
    const original = await this.adapter.read(key);
    await this.adapter.wrapped.saveRaw(original, sized);
    return original;
  }

  async settled(bytes: Buffer): Promise<boolean> {
    return !this.adapter.hold.isPending(digestOf(bytes));
  }

  uploadedKeys(): string[] {
    return [...this.keys];
  }

  async cleanup(): Promise<void> {
    await fs.rm(this.scratch, { recursive: true, force: true });
  }
}

export type Interfere = (phase: string) => Promise<void> | void;
const noInterference: Interfere = () => {};

// Every key under which the bytes sit in the bucket, read directly.
async function keysHolding(bucket: BucketView, bytes: Buffer): Promise<string[]> {
  const found: string[] = [];
  for (const key of await bucket.keys()) {
    const body = await bucket.read(key);
    if (body !== null && body.equals(bytes)) found.push(key);
  }
  return found;
}

// Served by any route: the original, a size, or a direct read of the bucket key.
async function servedAnywhere(surface: TenantSurface): Promise<string[]> {
  const served: string[] = [];
  for (const key of surface.uploadedKeys()) {
    if (
      (await surface.serves(key)) ||
      (await surface.sizeRequest(key)) !== null ||
      (await surface.bucket.read(key)) !== null
    ) {
      served.push(key);
    }
  }
  return served;
}

// Refusal. The hash is first offered to the service (the upload is held, as any
// unknown hash is), the service answers it as a match, and the next upload of
// the same bytes must be refused with the typed 415. Nothing about the bytes may
// ever be served, and the bucket must hold nothing: no object under any key,
// read directly.
export async function assertRefusal(
  surface: TenantSurface,
  service: StandInService,
  bytes: Buffer,
  interfere: Interfere = noInterference
): Promise<void> {
  const key = keyOf(bytes);
  const first = await surface.upload('first.png', bytes);
  if (first.accepted) await service.drain(key, 1500);
  await until(() => surface.settled(bytes), 4000);
  await interfere('after-answer');

  const second = await surface.upload('second.png', bytes);
  must(
    'refusal.upload-refused',
    !second.accepted && second.status === 415,
    `the second upload gave status ${second.status}, accepted=${second.accepted}`
  );
  const served = await servedAnywhere(surface);
  must('refusal.nothing-served', served.length === 0, `served: ${served.join(', ')}`);
  const keys = await surface.bucket.keys();
  must('refusal.not-in-bucket', keys.length === 0, `the bucket holds: ${keys.join(', ')}`);
}

// Hold. With the service not draining, an upload is accepted and a URL is
// returned; the URL serves nothing, a size request returns nothing and writes no
// derivative, and a direct read of the bucket key returns nothing because the
// object was never written: no object, and no write of that key at any time.
// That stays true across several retry rounds.
export async function assertHold(
  surface: TenantSurface,
  bytes: Buffer,
  interfere: Interfere = noInterference
): Promise<string> {
  const upload = await surface.upload('held.png', bytes);
  must(
    'hold.upload-accepted',
    upload.accepted && upload.key !== null,
    `the upload gave status ${upload.status}`
  );
  const key = upload.key as string;
  await interfere('after-upload');

  must('hold.original-not-served', !(await surface.serves(key)), 'the original is served');
  const sized = await surface.sizeRequest(key);
  const derivatives = (await surface.bucket.keys()).filter((k) => k.includes('/size/'));
  must(
    'hold.size-request-empty',
    sized === null && derivatives.length === 0,
    `size request gave ${sized === null ? 'nothing' : 'bytes'}, derivatives: ${derivatives.length}`
  );

  const direct = await surface.bucket.read(key);
  const holding = await keysHolding(surface.bucket, bytes);
  const written = await surface.bucket.everWritten(key);
  must(
    'hold.absent-from-bucket',
    direct === null && !written && holding.length === 0,
    `direct read ${direct === null ? 'nothing' : 'bytes'}, ever written=${written}, held under: ${holding.join(', ')}`
  );

  await wait(500);
  await interfere('after-retries');
  const still = await servedAnywhere(surface);
  const inBucket = await keysHolding(surface.bucket, bytes);
  must(
    'hold.stays-withheld',
    still.length === 0 && inBucket.length === 0,
    `served after retries: ${still.join(', ')}; in the bucket: ${inBucket.join(', ')}`
  );
  return key;
}

// Promotion. Once the service answers clean, the object is present in the bucket
// (a direct read returns the bytes) and served (the size request returns the
// image). `timeoutMs` bounds the wait so a control that never answers is quick.
export async function assertPromotion(
  surface: TenantSurface,
  service: StandInService,
  bytes: Buffer,
  key: string,
  { drain = true, timeoutMs = 5000 } = {}
): Promise<void> {
  if (drain) await service.drain(keyOf(bytes));
  const got: { direct: Buffer | null } = { direct: null };
  await until(async () => {
    got.direct = await surface.bucket.read(key);
    return got.direct !== null;
  }, timeoutMs);
  must(
    'promotion.present-in-bucket',
    got.direct !== null && got.direct.equals(bytes),
    'a direct read of the bucket key did not return the bytes after a clean verdict'
  );
  const image = await surface.sizeRequest(key);
  must(
    'promotion.served',
    image !== null && image.equals(bytes),
    'the size request did not return the image after a clean verdict'
  );
}

// The pair. The same test-classification bytes through the demo tier's adapter
// must also refuse, so a tenant tier that refuses cannot pass the gate on a
// platform whose demo tier does not, and the reverse.
export async function assertDemoTierAlsoRefuses(
  demo: DemoSlot,
  demoService: StandInService,
  bytes: Buffer
): Promise<void> {
  try {
    await assertDemoRefusal(demo, demoService, bytes);
  } catch (error) {
    if (!(error instanceof GateFailure)) throw error;
    must('pair.demo-tier-refuses', false, `the demo tier did not refuse: ${error.message}`);
  }
  must('pair.demo-tier-refuses', true, '');
}

// Age. The tenant host end's oldest-unverdicted age grows while the service is
// not draining and is zero once the verdict is in. It is read from the host
// end's own renderer, the text its textfile is made of; that the estate scrapes
// that file is a shared-infra concern (tenant-tier-gates.md).
export async function assertAge(
  surface: TenantSurface,
  channel: Channel,
  service: StandInService,
  bytes: Buffer,
  interfere: Interfere = noInterference
): Promise<void> {
  await surface.upload('aged.png', bytes);
  channel.advance(120_000);
  const early = channel.oldestAgeSeconds();
  channel.advance(60_000);
  const later = channel.oldestAgeSeconds();
  must(
    'age.grows-while-undrained',
    early >= 120 && later - early >= 59,
    `age read ${early} then ${later}`
  );

  await service.drain(keyOf(bytes));
  await interfere('before-zero');
  const settled = channel.oldestAgeSeconds();
  must('age.returns-to-zero', settled === 0, `age read ${settled} after the verdict`);
}

export { FIXTURES };
