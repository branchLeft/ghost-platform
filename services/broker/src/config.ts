import { readFileSync } from 'node:fs';
import type { ZoneConfig } from '@branchleft/ghost-platform-render-core';

export interface BrokerConfig {
  readonly port: number;
  readonly host: string;
  /** The shared slots file the demo-gate also reads (host -> gate hash). */
  readonly slotsPath: string;
  /** The broker's own lease directory -- `render-core`'s `leaseRecordFileName`. */
  readonly leaseDir: string;
  /** Where this service persists each slot's coarse phase between requests. */
  readonly stateDir: string;
  /** The directory holding one drain-flag file per (slot, colour). */
  readonly drainFlagDir: string;
  /** Root of the per-slot, root-owned directories `/reconcile` writes rendered artefacts into. */
  readonly slotDirBase: string;
  /** Ed25519 public key the caller's (portal/reaper/harness) requests are verified against. */
  readonly verifyKey: Buffer;
  /** How old a request's timestamp may be before it is refused as stale. */
  readonly replayWindowSeconds: number;
  /** The forced-command wrapper LLD-2 §02 enumerates in sudoers -- overridable so a sandbox can substitute a non-privileged stand-in. */
  readonly wrapperCommand: string;
  /** Prepended to `wrapperCommand`'s argv -- `sudo` in production, empty in a sandbox that runs the stand-in directly. */
  readonly wrapperPrefix: readonly string[];
  readonly wrapperTimeoutMs: number;
  readonly zones: ZoneConfig;
  /**
   * The closed set of legal slot literals -- LLD-2 §02's whole point is
   * that this set is finite and known before any request arrives, mirrored
   * from `demo-host/provision/render_slot_sudoers.py`'s `SLOT_NAMES`
   * (kept as a separate literal set deliberately: that file enumerates
   * sudoers, this one enumerates what an HTTP caller may address, and nothing
   * here reads that Python file at runtime).
   */
  readonly slotLiterals: readonly string[];
  /** How long `GET /drain` holds an open request with nothing to hand over. */
  readonly drainPollTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
  /**
   * `healthPortBase + Number(slot)` is this slot's sidecar health port --
   * incidental (LLD-2 §01's figcaption: "the uid base and the port base are
   * all arbitrary within their constraints"), mirrored here rather than
   * computed from `render-core`, which has no slot concept of its own and
   * reads `uid`/`ports` straight off the descriptor -- the slot -> port
   * mapping stays owned by `slotPorts.ts`, in this service.
   */
  readonly healthPortBase: number;
  /** `appPortBase + Number(slot)*2 (+1 for colour b)` -- see `slotPorts.ts`. */
  readonly appPortBase: number;
  /**
   * `uidBase + Number(slot)` is this slot's reserved uid -- incidental in the
   * exact base (LLD-2 §01's figcaption again), mirrored here for the same
   * reason `healthPortBase` is: no package yet owns the slot -> uid mapping.
   * See `slotPorts.ts`'s `slotUid`.
   */
  readonly uidBase: number;
  /**
   * Captured once, at config load (server start), never from a request or
   * the caller's clock. A signed request whose timestamp predates this
   * process refuses regardless of the replay window: a restart is not the
   * discontinuity a shorter-than-restart-time window would otherwise rely
   * on to invalidate a captured request (see `auth.ts`).
   */
  readonly processStartSeconds: number;
  readonly nowMs: () => number;
}

export type BrokerEnv = Record<string, string | undefined>;

function requireEnv(env: BrokerEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInteger(env: BrokerEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max}`);
  }
  return Number(raw);
}

/**
 * The one place `BROKER_DEMO_ZONE`/`BROKER_PLATFORM_ZONE`/`BROKER_OWNED_DOMAINS`
 * are read. Exported so a plugin loaded by `loadPlugin` (which only ever
 * `import()`s a module path and reads its default export -- it has no
 * channel to receive `BrokerConfig.zones` directly) can call the exact
 * same parsing this module uses, rather than keeping its own copy that
 * could drift from it.
 */
export function zonesFromEnv(env: BrokerEnv): ZoneConfig {
  return {
    demoZone: requireEnv(env, 'BROKER_DEMO_ZONE'),
    platformZone: requireEnv(env, 'BROKER_PLATFORM_ZONE'),
    ownedDomains: requireEnv(env, 'BROKER_OWNED_DOMAINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Every input that decides who may cause a side effect has no default: the
 * verify key, the slots path and the lease/state/drain-flag directories. An
 * unset value refuses to start rather than guessing -- the same posture
 * `services/demo-gate`'s config takes for the same reason.
 */
export function loadConfig(
  env: BrokerEnv,
  readKey: (path: string) => Buffer = (path) => readFileSync(path)
): BrokerConfig {
  const verifyKey = readKey(requireEnv(env, 'BROKER_VERIFY_KEY_FILE'));
  if (verifyKey.length !== 32) {
    // A raw Ed25519 public key is exactly 32 bytes; anything else is a
    // format mistake (PEM, the wrong key) that must not silently verify
    // against a truncated or padded comparison.
    throw new Error(
      'BROKER_VERIFY_KEY_FILE must hold exactly 32 raw bytes (an Ed25519 public key)'
    );
  }
  const wrapperPrefixRaw = env.BROKER_WRAPPER_PREFIX;
  return {
    port: positiveInteger(env, 'PORT', 8090, 65535),
    host: env.LISTEN_HOST || '127.0.0.1',
    slotsPath: requireEnv(env, 'BROKER_SLOTS_FILE'),
    leaseDir: requireEnv(env, 'BROKER_LEASE_DIR'),
    stateDir: requireEnv(env, 'BROKER_STATE_DIR'),
    drainFlagDir: requireEnv(env, 'BROKER_DRAIN_FLAG_DIR'),
    slotDirBase: requireEnv(env, 'BROKER_SLOT_DIR_BASE'),
    verifyKey,
    replayWindowSeconds: positiveInteger(env, 'BROKER_REPLAY_WINDOW_SECONDS', 60, 3600),
    wrapperCommand: env.BROKER_WRAPPER_COMMAND || '/usr/local/sbin/branchleft-slot',
    wrapperPrefix:
      wrapperPrefixRaw === undefined ? ['sudo', '-n'] : wrapperPrefixRaw.split(' ').filter(Boolean),
    wrapperTimeoutMs: positiveInteger(env, 'BROKER_WRAPPER_TIMEOUT_MS', 30_000, 300_000),
    zones: zonesFromEnv(env),
    slotLiterals: (env.BROKER_SLOT_LITERALS ?? '0,1,2,3,4,5,6')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    drainPollTimeoutMs: positiveInteger(env, 'BROKER_DRAIN_POLL_TIMEOUT_MS', 30_000, 120_000),
    healthCheckTimeoutMs: positiveInteger(env, 'BROKER_HEALTH_TIMEOUT_MS', 2_000, 30_000),
    healthPortBase: positiveInteger(env, 'BROKER_HEALTH_PORT_BASE', 9100, 65000),
    appPortBase: positiveInteger(env, 'BROKER_APP_PORT_BASE', 9300, 65000),
    uidBase: positiveInteger(env, 'BROKER_UID_BASE', 30001, 65000),
    processStartSeconds: Math.floor(Date.now() / 1000),
    nowMs: () => Date.now(),
  };
}
