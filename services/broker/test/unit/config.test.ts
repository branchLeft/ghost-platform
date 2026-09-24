import { describe, expect, it } from 'vitest';
import { loadConfig, type BrokerEnv } from '../../src/config.js';

function validEnv(overrides: Partial<BrokerEnv> = {}): BrokerEnv {
  return {
    BROKER_VERIFY_KEY_FILE: '/keys/verify.raw',
    BROKER_SLOTS_FILE: '/data/slots.json',
    BROKER_LEASE_DIR: '/data/lease',
    BROKER_STATE_DIR: '/data/state',
    BROKER_DRAIN_FLAG_DIR: '/data/drain-flags',
    BROKER_SLOT_DIR_BASE: '/opt/branchleft',
    BROKER_DEMO_ZONE: 'demo-domain.example.test',
    BROKER_PLATFORM_ZONE: 'platform-domain.example.test',
    BROKER_OWNED_DOMAINS: 'demo-domain.example.test,platform-domain.example.test',
    ...overrides,
  };
}

const readKey32 = () => Buffer.alloc(32, 7);

describe('loadConfig', () => {
  it('loads every required field, with defaults applied for everything optional', () => {
    const config = loadConfig(validEnv(), readKey32);
    expect(config.port).toBe(8090);
    expect(config.host).toBe('127.0.0.1');
    expect(config.slotsPath).toBe('/data/slots.json');
    expect(config.leaseDir).toBe('/data/lease');
    expect(config.stateDir).toBe('/data/state');
    expect(config.drainFlagDir).toBe('/data/drain-flags');
    expect(config.slotDirBase).toBe('/opt/branchleft');
    expect(config.verifyKey).toEqual(Buffer.alloc(32, 7));
    expect(config.replayWindowSeconds).toBe(60);
    expect(config.wrapperCommand).toBe('/usr/local/sbin/branchleft-slot');
    expect(config.wrapperPrefix).toEqual(['sudo', '-n']);
    expect(config.wrapperTimeoutMs).toBe(30_000);
    expect(config.zones).toEqual({
      demoZone: 'demo-domain.example.test',
      platformZone: 'platform-domain.example.test',
      ownedDomains: ['demo-domain.example.test', 'platform-domain.example.test'],
    });
    expect(config.slotLiterals).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(config.drainPollTimeoutMs).toBe(30_000);
    expect(config.healthCheckTimeoutMs).toBe(2_000);
    expect(config.healthPortBase).toBe(9100);
    expect(typeof config.nowMs()).toBe('number');
  });

  it('refuses a verify key that is not exactly 32 bytes', () => {
    expect(() => loadConfig(validEnv(), () => Buffer.alloc(31))).toThrow(/exactly 32 raw bytes/);
    expect(() => loadConfig(validEnv(), () => Buffer.alloc(33))).toThrow(/exactly 32 raw bytes/);
  });

  it.each([
    'BROKER_VERIFY_KEY_FILE',
    'BROKER_SLOTS_FILE',
    'BROKER_LEASE_DIR',
    'BROKER_STATE_DIR',
    'BROKER_DRAIN_FLAG_DIR',
    'BROKER_SLOT_DIR_BASE',
    'BROKER_DEMO_ZONE',
    'BROKER_PLATFORM_ZONE',
    'BROKER_OWNED_DOMAINS',
  ])('refuses to start with %s unset', (name) => {
    const env = validEnv({ [name]: undefined });
    expect(() => loadConfig(env, readKey32)).toThrow(
      new RegExp(`Missing required environment variable ${name}`)
    );
  });

  it('respects explicit overrides for every optional field', () => {
    const config = loadConfig(
      validEnv({
        PORT: '9999',
        LISTEN_HOST: '0.0.0.0',
        BROKER_REPLAY_WINDOW_SECONDS: '120',
        BROKER_WRAPPER_COMMAND: '/tmp/stand-in',
        BROKER_WRAPPER_PREFIX: '',
        BROKER_WRAPPER_TIMEOUT_MS: '5000',
        BROKER_SLOT_LITERALS: '0,1',
        BROKER_DRAIN_POLL_TIMEOUT_MS: '10000',
        BROKER_HEALTH_TIMEOUT_MS: '3000',
        BROKER_HEALTH_PORT_BASE: '9200',
      }),
      readKey32
    );
    expect(config.port).toBe(9999);
    expect(config.host).toBe('0.0.0.0');
    expect(config.replayWindowSeconds).toBe(120);
    expect(config.wrapperCommand).toBe('/tmp/stand-in');
    // An explicit empty prefix (the sandbox running the stand-in directly,
    // no `sudo`) is a real, distinct configuration from "unset" -- filter(Boolean)
    // on an empty string yields [], not ['sudo', '-n'].
    expect(config.wrapperPrefix).toEqual([]);
    expect(config.wrapperTimeoutMs).toBe(5000);
    expect(config.slotLiterals).toEqual(['0', '1']);
    expect(config.drainPollTimeoutMs).toBe(10_000);
    expect(config.healthCheckTimeoutMs).toBe(3_000);
    expect(config.healthPortBase).toBe(9200);
  });

  it('rejects a non-numeric or out-of-range value for a bounded integer field', () => {
    expect(() => loadConfig(validEnv({ PORT: 'not-a-number' }), readKey32)).toThrow(
      /must be a whole number/
    );
    expect(() => loadConfig(validEnv({ PORT: '999999' }), readKey32)).toThrow(
      /must be a whole number/
    );
    expect(() => loadConfig(validEnv({ PORT: '0' }), readKey32)).toThrow(/must be a whole number/);
  });

  it('splits and trims a comma-separated owned-domains list, dropping empty entries', () => {
    const config = loadConfig(
      validEnv({ BROKER_OWNED_DOMAINS: ' a.example.test , ,b.example.test ' }),
      readKey32
    );
    expect(config.zones.ownedDomains).toEqual(['a.example.test', 'b.example.test']);
  });

  it('reads the verify key through the injected readKey function, at the required path', () => {
    const calls: string[] = [];
    loadConfig(validEnv({ BROKER_VERIFY_KEY_FILE: '/custom/path' }), (path) => {
      calls.push(path);
      return Buffer.alloc(32);
    });
    expect(calls).toEqual(['/custom/path']);
  });
});
