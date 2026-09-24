import { createServer, type Server } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { TenantDescriptor, ZoneConfig } from '@branchleft/ghost-platform-render-core';
import { createBrokerHandler, type BrokerDeps } from '../../src/app.js';
import type { AdminApiClient } from '../../src/adminApi.js';
import { createInMemoryNonceStore } from '../../src/nonceStore.js';
import { createDrainFlagStore } from '../../src/drainFlag.js';
import type { DrainPayload, DrainSource } from '../../src/drainSource.js';
import { createHttpHealthChecker } from '../../src/healthCheck.js';
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

export interface TestBroker {
  readonly baseUrl: string;
  readonly keyPair: TestKeyPair;
  readonly zones: ZoneConfig;
  readonly renderer: RecordingRenderer;
  readonly adminApi: RecordingAdminApi;
  readonly drainSource: ControllableDrainSource;
  readonly wrapperLogPath: string;
  readonly stateDir: string;
  readonly leaseDir: string;
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

export async function startTestBroker(): Promise<TestBroker> {
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

  const handler = createBrokerHandler(deps);
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
    wrapperLogPath,
    stateDir,
    leaseDir,
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
