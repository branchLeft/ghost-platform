import type { SlotName } from '@branchleft/ghost-platform-render-core';
import type { DemoEstate } from '../../src/controlPlaneDemoDescriptor.js';
import type { GateIssuer } from '../../src/controlPlaneDemoGate.js';
import { createTunnelBroker, type DemoBroker } from '../../src/controlPlaneDemoBroker.js';
import type {
  Arrival,
  LifecycleStore,
  ProvisionDeps,
  ProvisionState,
  StoredEvent,
} from '../../src/controlPlaneDemoProvision.js';
import type { HealthChecker } from '../../src/healthCheck.js';
import { TEST_ZONES } from './fixtures.js';
import type { TestBroker } from './testBroker.js';

export const DEMO_ID = '0b9f3a52-6a1c-4c53-9f7e-2b1d5f0c8e11';
export const OWNER = 'owner@example.com';
export const LEASE_MS = 7 * 24 * 60 * 60 * 1000;

export const ESTATE: DemoEstate = {
  zones: TEST_ZONES,
  image: `ghost:6.55.0-alpine@sha256:${'a'.repeat(64)}`,
  appHostIp: '10.20.1.50',
  uidBase: 30001,
  appPortBase: 9300,
  healthPortBase: 10100,
  dataRoot: '/data',
  spoolRoot: '/var/spool',
  mail: { ceiling: 20, estateCeiling: 500 },
  limits: { membersCap: 50, staffCap: 1 },
  caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
};

/** Distinct passphrases and hashes per call, with no argon2 cost: the hash is the gate's concern, not this step's. */
export function countingGate(): GateIssuer & { readonly issued: string[] } {
  const issued: string[] = [];
  return {
    issued,
    async issue() {
      const n = issued.length + 1;
      const passphrase = `pass-${n}`;
      issued.push(passphrase);
      return { passphrase, argon2idHash: `$argon2id$v=19$m=65536,t=3,p=4$c2FsdA${n}$aGFzaA${n}` };
    },
  };
}

/**
 * The lifecycle store's behaviour that provisioning depends on, in memory:
 * a hostname is allocated only while CLAIMED, entering PROVISIONING issues a
 * seven-day term from the store's own clock, and every move is recorded.
 */
export interface FakeStore extends LifecycleStore {
  readonly moves: ProvisionState[];
  readonly retired: string[];
  state(): string;
  /** Makes the next `retireHostname` fail, as the register refusing a second retirement would. */
  failRetire: boolean;
}

export function fakeStore(clockMs: () => number, startState = 'CLAIMED'): FakeStore {
  let state = startState;
  let label: string | null = null;
  let leaseEndsAt: Date | null = null;
  const moves: ProvisionState[] = [];
  const retired: string[] = [];
  const event = (): StoredEvent => ({ toState: state, leaseEndsAt });
  return {
    moves,
    retired,
    failRetire: false,
    state: () => state,
    async currentState() {
      return event();
    },
    async request() {
      return { verifiedAddress: OWNER };
    },
    async hostname() {
      return label;
    },
    async allocateHostname() {
      if (state !== 'CLAIMED') throw new Error('allocation outside CLAIMED');
      label = 'k7mvalebrightq2w3e4r5';
      return label;
    },
    async transition(_demoId, to) {
      moves.push(to);
      if (to === 'PROVISIONING') leaseEndsAt = new Date(clockMs() + LEASE_MS);
      state = to;
      return event();
    },
    async retireHostname(name) {
      if (this.failRetire) throw new Error('retire sabotage failure');
      retired.push(name);
    },
  };
}

/** A virtual clock: waiting advances it, so a poll that would take a minute takes none. */
export function virtualClock(start = 1_700_000_100_000): {
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let now = start;
  return {
    nowMs: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
}

export interface ControllableHealth extends HealthChecker {
  /** Answers per call from this list, then the last entry for every call after. */
  script(answers: readonly boolean[]): void;
  calls: number;
}

export function controllableHealth(): ControllableHealth {
  let answers: readonly boolean[] = [true];
  const state = {
    calls: 0,
    script(next: readonly boolean[]) {
      answers = next;
      state.calls = 0;
    },
    async isHealthy() {
      const answer = answers[Math.min(state.calls, answers.length - 1)] as boolean;
      state.calls += 1;
      return answer;
    },
  };
  return state;
}

export function tunnelTo(
  broker: TestBroker,
  overrides: { fetch?: typeof globalThis.fetch } = {}
): DemoBroker {
  return createTunnelBroker({
    baseUrl: broker.baseUrl,
    privateKeyRaw: broker.keyPair.privateKeyRaw,
    nowSeconds: () => Math.floor(broker.nowMs() / 1000),
    timeoutMs: 5000,
    ...overrides,
  });
}

/** An arrival mailer that records what it was given, and fails on demand. */
export interface RecordingMailer {
  readonly sent: Arrival[];
  /** When set, the next sends throw, as a mail relay that is down would. */
  fail: boolean;
  send(arrival: Arrival): Promise<void>;
}

export function recordingMailer(): RecordingMailer {
  const mailer: RecordingMailer = {
    sent: [],
    fail: false,
    async send(arrival) {
      if (mailer.fail) throw new Error('mail sabotage failure');
      mailer.sent.push(arrival);
    },
  };
  return mailer;
}

export function depsFor(
  store: LifecycleStore,
  broker: DemoBroker,
  gate: GateIssuer,
  clock: { nowMs: () => number; sleep: (ms: number) => Promise<void> },
  logs: string[] = [],
  sendArrival: (arrival: Arrival) => Promise<void> = async () => undefined
): ProvisionDeps {
  return {
    store,
    broker,
    estate: ESTATE,
    gate,
    sleep: clock.sleep,
    nowMs: clock.nowMs,
    pollIntervalMs: 1000,
    provisionTimeoutMs: 30_000,
    resendLimit: 2,
    sendArrival,
    log: (line) => logs.push(line),
  };
}

export const SLOT = '1' as SlotName;
