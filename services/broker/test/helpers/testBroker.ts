import { createServer, type Server } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type {
  SlotName,
  TenantDescriptor,
  ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
import { createBrokerHandler, type BrokerDeps } from '../../src/app.js';
import type { AdminApiClient } from '../../src/adminApi.js';
import { createInMemoryNonceStore } from '../../src/nonceStore.js';
import { createDrainFlagStore } from '../../src/drainFlag.js';
import type { DrainPayload, DrainSource } from '../../src/drainSource.js';
import { createHttpHealthChecker } from '../../src/healthCheck.js';
import type { EmailBatchChecker } from '../../src/emailBatchChecker.js';
import type { RealTrafficChecker } from '../../src/realTraffic.js';
import type { Artefact, Renderer } from '../../src/render.js';
import { createSlotLock } from '../../src/slotLock.js';
import { createSlotWrapper } from '../../src/wrapper.js';
import { makeTempDir } from '../../src/atomicFile.js';
import { TEST_ZONES } from './fixtures.js';
import { generateTestKeyPair, signHeaders, type TestKeyPair } from './signer.js';

const FAKE_WRAPPER = fileURLToPath(new URL('./fakeWrapper.mjs', import.meta.url));

export interface RecordingRenderer extends Renderer {
  readonly calls: TenantDescriptor[];
  artefacts: readonly Artefact[];
  fail: boolean;
}

export interface RecordingAdminApi extends AdminApiClient {
  readonly calls: { baseUrl: string; descriptor: TenantDescriptor }[];
  fail: boolean;
}

export interface ControllableDrainSource extends DrainSource {
  resolveNextWith: (payload: DrainPayload) => void;
  rejectNextWith: (err: Error) => void;
}

export interface ControllableGhostReadiness {
  readonly calls: number[];
  isReady(port: number): Promise<boolean>;
  /** Every port reads ready by default; set `false` for a specific port to make it refuse. */
  setReady(port: number, ready: boolean): void;
  /**
   * Answers this port's *next* N calls with `values[0..N-1]` in order, then
   * keeps answering with `values`'s last entry -- for a test that needs a
   * colour to pass its bring-up readiness poll (the first call) and then
   * regress before the swap's second, independent check (the drain
   * refusal), which `setReady`'s single fixed verdict cannot express.
   */
  setReadySequence(port: number, values: readonly boolean[]): void;
}

export interface ControllableRealTraffic extends RealTrafficChecker {
  /** Every slot reads `0` by default (the fail-closed starting point). */
  setCount(slot: SlotName, count: number): void;
}

export interface ControllableEmailBatchChecker extends EmailBatchChecker {
  /** Every slot reads "no submitting batch" by default. */
  setSubmitting(slot: SlotName, submitting: boolean): void;
}

export interface TestBroker {
  readonly baseUrl: string;
  readonly keyPair: TestKeyPair;
  readonly zones: ZoneConfig;
  readonly renderer: RecordingRenderer;
  readonly adminApi: RecordingAdminApi;
  readonly drainSource: ControllableDrainSource;
  readonly ghostReadiness: ControllableGhostReadiness;
  readonly realTraffic: ControllableRealTraffic;
  readonly emailBatchChecker: ControllableEmailBatchChecker;
  readonly wrapperLogPath: string;
  readonly stateDir: string;
  readonly leaseDir: string;
  readonly drainFlagDir: string;
  readonly slotsPath: string;
  readonly nowMs: () => number;
  readonly processStartSeconds: number;
  setNowMs(value: number): void;
  signedFetch(method: string, path: string, body?: unknown): Promise<Response>;
  close(): Promise<void>;
}

function createRecordingRenderer(): RecordingRenderer {
  return {
    calls: [],
    artefacts: [{ path: 'ghost.env', content: 'NODE_ENV=production\n' }],
    fail: false,
    async render(descriptor) {
      this.calls.push(descriptor);
      if (this.fail) throw new Error('renderer sabotage failure');
      return this.artefacts;
    },
  };
}

function createRecordingAdminApi(): RecordingAdminApi {
  return {
    calls: [],
    fail: false,
    async configure(baseUrl, descriptor) {
      this.calls.push({ baseUrl, descriptor });
      if (this.fail) throw new Error('admin API sabotage failure');
    },
  };
}

function createControllableGhostReadiness(): ControllableGhostReadiness {
  const overrides = new Map<number, boolean>();
  const sequences = new Map<number, boolean[]>();
  const sequenceIndex = new Map<number, number>();
  return {
    calls: [],
    async isReady(port) {
      this.calls.push(port);
      const sequence = sequences.get(port);
      if (sequence) {
        const index = sequenceIndex.get(port) ?? 0;
        sequenceIndex.set(port, index + 1);
        return sequence[Math.min(index, sequence.length - 1)] as boolean;
      }
      return overrides.get(port) ?? true;
    },
    setReady(port, ready) {
      overrides.set(port, ready);
    },
    setReadySequence(port, values) {
      sequences.set(port, [...values]);
      sequenceIndex.set(port, 0);
    },
  };
}

function createControllableDrainSource(): ControllableDrainSource {
  const resolvers: ((payload: DrainPayload) => void)[] = [];
  const rejecters: ((err: Error) => void)[] = [];
  return {
    poll(signal) {
      return new Promise((resolve, reject) => {
        resolvers.push(resolve);
        rejecters.push(reject);
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
    resolveNextWith(payload) {
      const next = resolvers.shift();
      rejecters.shift();
      if (next) next(payload);
    },
    rejectNextWith(err) {
      resolvers.shift();
      const next = rejecters.shift();
      if (next) next(err);
    },
  };
}

function createControllableRealTraffic(): ControllableRealTraffic {
  const counts = new Map<string, number>();
  return {
    async readCount(slot) {
      return counts.get(slot) ?? 0;
    },
    setCount(slot, count) {
      counts.set(slot, count);
    },
  };
}

function createControllableEmailBatchChecker(): ControllableEmailBatchChecker {
  const submitting = new Map<string, boolean>();
  return {
    async hasSubmittingBatch(slot) {
      return submitting.get(slot) ?? false;
    },
    setSubmitting(slot, value) {
      submitting.set(slot, value);
    },
  };
}

export interface TestBrokerOptions {
  /** Lets a test interpose on the real dependencies, e.g. to observe on-disk state at each await. */
  readonly wrapDeps?: (deps: BrokerDeps) => BrokerDeps;
}

export async function startTestBroker(options: TestBrokerOptions = {}): Promise<TestBroker> {
  const root = await makeTempDir('broker-app-');
  const stateDir = join(root, 'state');
  const leaseDir = join(root, 'lease');
  const drainFlagDir = join(root, 'drain-flags');
  const slotDirBase = join(root, 'slots');
  const slotsPath = join(root, 'slots.json');
  const wrapperLogPath = join(root, 'wrapper.log');
  await Promise.all([mkdir(stateDir), mkdir(leaseDir), mkdir(drainFlagDir), mkdir(slotDirBase)]);
  process.env.FAKE_WRAPPER_LOG = wrapperLogPath;

  const keyPair = generateTestKeyPair();
  const START_MS = 1_700_000_000_000;
  const processStartSeconds = Math.floor(START_MS / 1000);
  // Ordinary "now" starts a comfortable five seconds after the process's own
  // start second, not at exactly the same instant: `auth.ts`'s replay floor
  // is now `<=` (F3's same-second edge, item 2), so a `nowMs` that started
  // equal to `processStartSeconds` would refuse every test's very first
  // request. Tests that specifically want the same-second edge call
  // `setNowMs` to move it back to `START_MS` deliberately.
  let nowMs = START_MS + 5_000;

  const renderer = createRecordingRenderer();
  const adminApi = createRecordingAdminApi();
  const drainSource = createControllableDrainSource();
  const ghostReadiness = createControllableGhostReadiness();
  const realTraffic = createControllableRealTraffic();
  const emailBatchChecker = createControllableEmailBatchChecker();

  const deps: BrokerDeps = {
    auth: {
      verifyKey: keyPair.publicKeyRaw,
      replayWindowSeconds: 60,
      nonces: createInMemoryNonceStore(60_000),
      processStartSeconds,
      nowMs: () => nowMs,
    },
    slotLiterals: ['0', '1', '2', '3', '4', '5', '6'],
    zones: TEST_ZONES,
    wrapper: createSlotWrapper({
      command: FAKE_WRAPPER,
      prefix: [process.execPath],
      timeoutMs: 5000,
    }),
    renderer,
    adminApi,
    drainSource,
    leaseStoreConfig: { slotsPath, leaseDir, nowMs: () => nowMs },
    drainFlags: createDrainFlagStore(drainFlagDir),
    healthChecker: createHttpHealthChecker('127.0.0.1', 500),
    ghostReadiness,
    realTraffic,
    emailBatchChecker,
    ghostReadyPollTimeoutMs: 300,
    healthPortBase: 9100,
    appPortBase: 9300,
    uidBase: 30001,
    slotDirBase,
    stateDir,
    slotLock: createSlotLock(),
    drainPollTimeoutMs: 300,
    nowMs: () => nowMs,
    log: () => {
      /* silenced in tests */
    },
  };

  const handler = createBrokerHandler(options.wrapDeps ? options.wrapDeps(deps) : deps);
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    keyPair,
    zones: TEST_ZONES,
    renderer,
    adminApi,
    drainSource,
    ghostReadiness,
    realTraffic,
    emailBatchChecker,
    wrapperLogPath,
    stateDir,
    leaseDir,
    drainFlagDir,
    slotsPath,
    nowMs: () => nowMs,
    processStartSeconds,
    setNowMs: (value) => {
      nowMs = value;
    },
    async signedFetch(method, path, body) {
      const rawBody = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
      const headers = signHeaders(keyPair, method, path, rawBody, Math.floor(nowMs / 1000));
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : rawBody,
      });
    },
    async close() {
      delete process.env.FAKE_WRAPPER_LOG;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
