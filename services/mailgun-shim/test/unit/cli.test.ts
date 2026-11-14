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

    const code = await runCli(
      ['register', 'tenant.example.com', '--sender-domain', 'tenant.example.com'],
      () => store,
      io
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(store.tenantExists('tenant.example.com')).toBe(true);

    const keyLines = stdout.filter((line) => KEY_SHAPE.test(line));
    expect(keyLines).toHaveLength(1);
  });

  it('records the given --sender-domain, separately from the credential domain', async () => {
    const store = createFakeStore();
    const { io, stdout } = captureIo();

    const code = await runCli(
      ['register', 'blog.branchleft.co.uk', '--sender-domain', 'branchleft.co.uk'],
      () => store,
      io
    );

    expect(code).toBe(0);
    const apiKey = stdout.find((line) => KEY_SHAPE.test(line));
    expect(apiKey).toBeDefined();
    await expect(store.verifyTenant('blog.branchleft.co.uk', apiKey!)).resolves.toEqual({
      domain: 'blog.branchleft.co.uk',
      senderDomain: 'branchleft.co.uk',
    });
  });

  it('refuses to register without --sender-domain, and creates nothing', async () => {
    const store = createFakeStore();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(['register', 'tenant.example.com'], () => store, io);

    expect(code).toBe(1);
    expect(stderr.some((line) => line.includes('--sender-domain'))).toBe(true);
    expect(stdout).toEqual([]);
    expect(store.tenantExists('tenant.example.com')).toBe(false);
  });

  it('refuses to overwrite an existing domain without --rotate, and leaves the old key working', async () => {
    const store = createFakeStore();
    store.registerTenant('tenant.example.com', 'existing-key', 'tenant.example.com');
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['register', 'tenant.example.com', '--sender-domain', 'tenant.example.com'],
      () => store,
      io
    );

    expect(code).toBe(1);
    expect(stderr.some((line) => line.includes('--rotate'))).toBe(true);
    expect(stdout).toEqual([]);
    await expect(store.verifyTenant('tenant.example.com', 'existing-key')).resolves.toEqual({
      domain: 'tenant.example.com',
      senderDomain: 'tenant.example.com',
    });
  });

  it('rotates an existing domain key with --rotate, invalidating the old one', async () => {
    const store = createFakeStore();
    store.registerTenant('tenant.example.com', 'old-key', 'tenant.example.com');
    const { io, stdout } = captureIo();

    const code = await runCli(
      ['register', 'tenant.example.com', '--sender-domain', 'tenant.example.com', '--rotate'],
      () => store,
      io
    );

    expect(code).toBe(0);
    await expect(store.verifyTenant('tenant.example.com', 'old-key')).resolves.toBeNull();
    const keyLine = stdout.find((line) => KEY_SHAPE.test(line));
    expect(keyLine).toBeDefined();
    await expect(store.verifyTenant('tenant.example.com', keyLine!)).resolves.toEqual({
      domain: 'tenant.example.com',
      senderDomain: 'tenant.example.com',
    });
  });

  it('requires a domain argument', async () => {
    const store = createFakeStore();
    const { io, stderr } = captureIo();
    const code = await runCli(['register'], () => store, io);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  // A flag consumed as the positional it was never meant to fill.
  it('refuses a flag in place of the positional credential-domain argument, and registers nothing', async () => {
    const store = createFakeStore();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(['register', '--sender-domain', 'x', 'd'], () => store, io);

    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toEqual([]);
    expect(store.tenantExists('--sender-domain')).toBe(false);
    expect(store.tenantExists('d')).toBe(false);
  });

  // A flag consumed as another flag's own value, because nothing checked
  // what followed --sender-domain before taking it.
  it('refuses a flag as the value of --sender-domain, and registers nothing', async () => {
    const store = createFakeStore();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['register', 'd.example.com', '--sender-domain', '--rotate'],
      () => store,
      io
    );

    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toEqual([]);
    expect(store.tenantExists('d.example.com')).toBe(false);
  });

  // Nothing validated the domain shape, so a typo (a leading '@', a bare
  // local-part, whitespace) registered successfully and failed silently
  // downstream — every real send against it refused, reading as the
  // sender-binding control being broken, not as a bad CLI argument.
  it('refuses a credential domain that is not a plain lowercase hostname, and registers nothing', async () => {
    const store = createFakeStore();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['register', '@branchleft.co.uk', '--sender-domain', 'branchleft.co.uk'],
      () => store,
      io
    );

    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toEqual([]);
    expect(store.tenantExists('@branchleft.co.uk')).toBe(false);
  });

  it('refuses a --sender-domain value that is not a plain lowercase hostname, and registers nothing', async () => {
    const store = createFakeStore();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['register', 'd.example.com', '--sender-domain', 'Not A Domain'],
      () => store,
      io
    );

    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toEqual([]);
    expect(store.tenantExists('d.example.com')).toBe(false);
  });

  it('closes the store it opened, even when registration fails', async () => {
    const store = createFakeStore();
    store.registerTenant('tenant.example.com', 'existing-key', 'tenant.example.com');
    let closed = false;
    const originalClose = store.close.bind(store);
    store.close = () => {
      closed = true;
      originalClose();
    };
    const { io } = captureIo();
    await runCli(
      ['register', 'tenant.example.com', '--sender-domain', 'tenant.example.com'],
      () => store,
      io
    );
    expect(closed).toBe(true);
  });
});

describe('runCli set-sender-domain', () => {
  it("updates an already-registered tenant's sender domain without rotating its key", async () => {
    const store = createFakeStore();
    store.registerTenant('blog.branchleft.co.uk', 'blog-key', null);
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['set-sender-domain', 'blog.branchleft.co.uk', 'branchleft.co.uk'],
      () => store,
      io
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["Set blog.branchleft.co.uk's sender domain to branchleft.co.uk."]);
    await expect(store.verifyTenant('blog.branchleft.co.uk', 'blog-key')).resolves.toEqual({
      domain: 'blog.branchleft.co.uk',
      senderDomain: 'branchleft.co.uk',
    });
  });

  it('refuses for a domain that was never registered, and prints no key-like output', async () => {
    const store = createFakeStore();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['set-sender-domain', 'never-registered.example.com', 'branchleft.co.uk'],
      () => store,
      io
    );

    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toEqual([]);
  });

  it('requires both arguments', async () => {
    const store = createFakeStore();
    const { io, stderr } = captureIo();
    const code = await runCli(['set-sender-domain', 'blog.branchleft.co.uk'], () => store, io);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  // Same two shapes as `register`'s own parsing.
  it('refuses a flag in place of either positional argument, and changes nothing', async () => {
    const store = createFakeStore();
    store.registerTenant('blog.branchleft.co.uk', 'blog-key', 'blog.branchleft.co.uk');
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['set-sender-domain', 'blog.branchleft.co.uk', '--rotate'],
      () => store,
      io
    );

    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toEqual([]);
    await expect(store.verifyTenant('blog.branchleft.co.uk', 'blog-key')).resolves.toEqual({
      domain: 'blog.branchleft.co.uk',
      senderDomain: 'blog.branchleft.co.uk',
    });
  });

  it('refuses a sender-domain argument that is not a plain lowercase hostname, and changes nothing', async () => {
    const store = createFakeStore();
    store.registerTenant('blog.branchleft.co.uk', 'blog-key', null);
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['set-sender-domain', 'blog.branchleft.co.uk', 'BRANCHLEFT.CO.UK'],
      () => store,
      io
    );

    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toEqual([]);
    await expect(store.verifyTenant('blog.branchleft.co.uk', 'blog-key')).resolves.toEqual({
      domain: 'blog.branchleft.co.uk',
      senderDomain: null,
    });
  });

  it('closes the store it opened, even when the domain is unknown', async () => {
    const store = createFakeStore();
    let closed = false;
    const originalClose = store.close.bind(store);
    store.close = () => {
      closed = true;
      originalClose();
    };
    const { io } = captureIo();
    await runCli(
      ['set-sender-domain', 'never-registered.example.com', 'branchleft.co.uk'],
      () => store,
      io
    );
    expect(closed).toBe(true);
  });
});

describe('runCli remove', () => {
  const SLOT = 'slot-30001.demo.example.com';

  async function registered(): Promise<{ store: ReturnType<typeof createFakeStore>; key: string }> {
    const store = createFakeStore();
    const { io, stdout } = captureIo();
    await runCli(['register', SLOT, '--sender-domain', 'demo.example.com'], () => store, io);
    return { store, key: stdout.find((line) => KEY_SHAPE.test(line))! };
  }

  it('removes the named row when --confirm repeats the domain, and its key stops authenticating', async () => {
    const { store, key } = await registered();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(['remove', SLOT, '--confirm', SLOT], () => store, io);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      `Removed ${SLOT} (sender domain: demo.example.com). Its key no longer authenticates.`,
    ]);
    expect(store.tenantExists(SLOT)).toBe(false);
    await expect(store.verifyTenant(SLOT, key)).resolves.toBeNull();
  });

  it('leaves every other row, including its key, untouched', async () => {
    const { store } = await registered();
    store.registerTenant('blog.branchleft.co.uk', 'blog-key', 'branchleft.co.uk');
    const { io } = captureIo();

    await runCli(['remove', SLOT, '--confirm', SLOT], () => store, io);

    await expect(store.verifyTenant('blog.branchleft.co.uk', 'blog-key')).resolves.toEqual({
      domain: 'blog.branchleft.co.uk',
      senderDomain: 'branchleft.co.uk',
    });
  });

  it('never prints a key', async () => {
    const { store } = await registered();
    const { io, stdout, stderr } = captureIo();
    await runCli(['remove', SLOT, '--confirm', SLOT], () => store, io);
    expect([...stdout, ...stderr].filter((line) => KEY_SHAPE.test(line))).toEqual([]);
  });

  it('refuses without --confirm, and removes nothing', async () => {
    const { store, key } = await registered();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(['remove', SLOT], () => store, io);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.some((line) => line.includes('--confirm'))).toBe(true);
    await expect(store.verifyTenant(SLOT, key)).resolves.not.toBeNull();
  });

  it('refuses a --confirm that names a different domain, and removes nothing', async () => {
    const { store, key } = await registered();
    store.registerTenant('slot-30002.demo.example.com', 'other', 'demo.example.com');
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['remove', SLOT, '--confirm', 'slot-30002.demo.example.com'],
      () => store,
      io
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.some((line) => line.includes('Nothing was removed'))).toBe(true);
    expect(store.tenantExists('slot-30002.demo.example.com')).toBe(true);
    await expect(store.verifyTenant(SLOT, key)).resolves.not.toBeNull();
  });

  it('refuses a --confirm with no value, and removes nothing', async () => {
    const { store } = await registered();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(['remove', SLOT, '--confirm'], () => store, io);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.length).toBeGreaterThan(0);
    expect(store.tenantExists(SLOT)).toBe(true);
  });

  it.each([
    ['no arguments', ['remove']],
    ['a flag in the domain slot', ['remove', '--confirm', '--confirm', '--confirm']],
    [
      'a domain with an uppercase letter',
      ['remove', 'Slot-30001.demo.example.com', '--confirm', 'Slot-30001.demo.example.com'],
    ],
    ['a bare TLD', ['remove', 'localhost', '--confirm', 'localhost']],
    ['a scheme', ['remove', 'https://x.example.com', '--confirm', 'https://x.example.com']],
    ['--confirm first', ['remove', '--confirm', SLOT, SLOT]],
    ['a trailing extra argument', ['remove', SLOT, '--confirm', SLOT, '--rotate']],
  ])('refuses %s with the usage line, and removes nothing', async (_name, argv) => {
    const { store } = await registered();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(argv, () => store, io);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.some((line) => line.startsWith('Usage: remove'))).toBe(true);
    expect(store.tenantExists(SLOT)).toBe(true);
  });

  it('refuses a domain that is not registered, and says so', async () => {
    const store = createFakeStore();
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(['remove', SLOT, '--confirm', SLOT], () => store, io);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.some((line) => line.includes('is not registered'))).toBe(true);
  });

  it('reports a row with no sender domain as NOT SET', async () => {
    const store = createFakeStore();
    store.registerTenant(SLOT, 'k', null);
    const { io, stdout } = captureIo();

    await runCli(['remove', SLOT, '--confirm', SLOT], () => store, io);

    expect(stdout[0]).toContain('sender domain: NOT SET');
  });

  it('lets the same domain be registered afresh without --rotate once removed', async () => {
    const { store, key } = await registered();
    await runCli(['remove', SLOT, '--confirm', SLOT], () => store, captureIo().io);
    const { io, stdout, stderr } = captureIo();

    const code = await runCli(
      ['register', SLOT, '--sender-domain', 'demo.example.com'],
      () => store,
      io
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const newKey = stdout.find((line) => KEY_SHAPE.test(line))!;
    expect(newKey).not.toBe(key);
    await expect(store.verifyTenant(SLOT, key)).resolves.toBeNull();
    await expect(store.verifyTenant(SLOT, newKey)).resolves.not.toBeNull();
  });
});

describe('runCli list', () => {
  it('lists registered domains only, sorted, with nothing key-like in the output', async () => {
    const store = createFakeStore();
    store.registerTenant('b.example.com', 'key-b', 'b.example.com');
    store.registerTenant('a.example.com', 'key-a', 'a.example.com');
    const { io, stdout } = captureIo();

    const code = await runCli(['list'], () => store, io);

    expect(code).toBe(0);
    expect(stdout).toEqual([
      'a.example.com (sender domain: a.example.com)',
      'b.example.com (sender domain: b.example.com)',
    ]);
    expect(stdout.some((line) => KEY_SHAPE.test(line))).toBe(false);
  });

  // The credential domain alone can't distinguish "set-sender-domain ran"
  // from "it didn't" — this is the real post-deploy diagnostic.
  it('shows NOT SET for a tenant with no sender domain, distinguishing it from a configured one', async () => {
    const store = createFakeStore();
    store.registerTenant('configured.example.com', 'key-a', 'configured.example.com');
    store.registerTenant('legacy.example.com', 'key-b', null);
    const { io, stdout } = captureIo();

    const code = await runCli(['list'], () => store, io);

    expect(code).toBe(0);
    expect(stdout).toEqual([
      'configured.example.com (sender domain: configured.example.com)',
      'legacy.example.com (sender domain: NOT SET)',
    ]);
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

  it('lists remove in the usage line', async () => {
    const store = createFakeStore();
    const { io, stderr } = captureIo();
    await runCli(['bogus'], () => store, io);
    expect(stderr.some((line) => line.includes('remove'))).toBe(true);
  });

  it('rejects no command at all', async () => {
    const store = createFakeStore();
    const { io, stderr } = captureIo();
    const code = await runCli([], () => store, io);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
