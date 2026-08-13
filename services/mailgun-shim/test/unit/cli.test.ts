import { describe, expect, it } from 'vitest';
import { generateApiKey, runCli, type CliIO } from '../../src/cli.js';
import { createFakeStore } from './helpers/fakeStore.js';

const KEY_SHAPE = /^[A-Za-z0-9_-]{40,}$/;

function captureIo(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    stdout,
    stderr,
  };
}

describe('generateApiKey', () => {
  it('generates a 32-byte key encoded as base64url', () => {
    const key = generateApiKey();
    expect(key).not.toMatch(/[+/=]/);
    expect(Buffer.from(key, 'base64url')).toHaveLength(32);
  });

  it('generates distinct keys on each call', () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe('runCli register', () => {
  it('registers a new domain and prints the key exactly once, to stdout only', async () => {
    const store = createFakeStore();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(['register', 'tenant.example.com'], () => store, io);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(store.tenantExists('tenant.example.com')).toBe(true);

    const keyLines = stdout.filter((line) => KEY_SHAPE.test(line));
    expect(keyLines).toHaveLength(1);
  });

  it('refuses to overwrite an existing domain without --rotate, and leaves the old key working', async () => {
    const store = createFakeStore();
    store.registerTenant('tenant.example.com', 'existing-key');
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(['register', 'tenant.example.com'], () => store, io);

    expect(code).toBe(1);
    expect(stderr.some((line) => line.includes('--rotate'))).toBe(true);
    expect(stdout).toEqual([]);
    expect(store.verifyTenant('tenant.example.com', 'existing-key')).toEqual({
      domain: 'tenant.example.com',
    });
  });

  it('rotates an existing domain key with --rotate, invalidating the old one', async () => {
    const store = createFakeStore();
    store.registerTenant('tenant.example.com', 'old-key');
    const { io, stdout } = captureIo();

    const code = await runCli(['register', 'tenant.example.com', '--rotate'], () => store, io);

    expect(code).toBe(0);
    expect(store.verifyTenant('tenant.example.com', 'old-key')).toBeNull();
    const keyLine = stdout.find((line) => KEY_SHAPE.test(line));
    expect(keyLine).toBeDefined();
    expect(store.verifyTenant('tenant.example.com', keyLine!)).toEqual({
      domain: 'tenant.example.com',
    });
  });

  it('requires a domain argument', async () => {
    const store = createFakeStore();
    const { io, stderr } = captureIo();
    const code = await runCli(['register'], () => store, io);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('closes the store it opened, even when registration fails', async () => {
    const store = createFakeStore();
    store.registerTenant('tenant.example.com', 'existing-key');
    let closed = false;
    const originalClose = store.close.bind(store);
    store.close = () => {
      closed = true;
      originalClose();
    };
    const { io } = captureIo();
    await runCli(['register', 'tenant.example.com'], () => store, io);
    expect(closed).toBe(true);
  });
});

describe('runCli list', () => {
  it('lists registered domains only, sorted, with nothing key-like in the output', async () => {
    const store = createFakeStore();
    store.registerTenant('b.example.com', 'key-b');
    store.registerTenant('a.example.com', 'key-a');
    const { io, stdout } = captureIo();

    const code = await runCli(['list'], () => store, io);

    expect(code).toBe(0);
    expect(stdout).toEqual(['a.example.com', 'b.example.com']);
    expect(stdout.some((line) => KEY_SHAPE.test(line))).toBe(false);
  });
});

describe('runCli events', () => {
  it('requires a domain argument', async () => {
    const store = createFakeStore();
    const { io, stderr } = captureIo();
    const code = await runCli(['events'], () => store, io);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('prints events for a domain as JSON lines, read-only', async () => {
    const store = createFakeStore();
    store.recordEvent({
      domain: 'tenant.example.com',
      type: 'delivered',
      severity: null,
      recipient: 'member@example.com',
      emailId: null,
      providerMessageId: null,
      timestamp: 1_700_000_000,
      errorCode: null,
      errorMessage: null,
    });
    const { io, stdout } = captureIo();

    const code = await runCli(['events', 'tenant.example.com'], () => store, io);

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    const event = JSON.parse(stdout[0]!) as { recipient: string };
    expect(event.recipient).toBe('member@example.com');
  });

  it('respects --limit', async () => {
    const store = createFakeStore();
    for (let i = 0; i < 5; i += 1) {
      store.recordEvent({
        domain: 'tenant.example.com',
        type: 'delivered',
        severity: null,
        recipient: `member-${i}@example.com`,
        emailId: null,
        providerMessageId: null,
        timestamp: 1_700_000_000,
        errorCode: null,
        errorMessage: null,
      });
    }
    const { io, stdout } = captureIo();
    await runCli(['events', 'tenant.example.com', '--limit', '2'], () => store, io);
    expect(stdout).toHaveLength(2);
  });

  it('falls back to the default limit for a non-numeric --limit', async () => {
    const store = createFakeStore();
    store.recordEvent({
      domain: 'tenant.example.com',
      type: 'delivered',
      severity: null,
      recipient: 'member@example.com',
      emailId: null,
      providerMessageId: null,
      timestamp: 1_700_000_000,
      errorCode: null,
      errorMessage: null,
    });
    const { io, stdout } = captureIo();
    const code = await runCli(
      ['events', 'tenant.example.com', '--limit', 'not-a-number'],
      () => store,
      io
    );
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
  });
});

describe('runCli unknown command', () => {
  it('rejects an unrecognised command', async () => {
    const store = createFakeStore();
    const { io, stderr } = captureIo();
    const code = await runCli(['bogus'], () => store, io);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('rejects no command at all', async () => {
    const store = createFakeStore();
    const { io, stderr } = captureIo();
    const code = await runCli([], () => store, io);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
