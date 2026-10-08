import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
import type { SmtpConfig } from '../src/config.js';
import { desiredState } from '../src/desired.js';
import { ConfigError } from '../src/errors.js';
import { managementClient } from '../src/management.js';
import type { FetchLike } from '../src/management.js';
import { reconcile } from '../src/reconcile.js';
import {
  isManaged,
  MANAGED_MARK,
  readSmtpPassword,
  smtpDescription,
  smtpFingerprint,
} from '../src/smtp.js';
import { FakeZitadel, HOSTNAMES, TWO_TENANTS } from './fakes.js';

const SMTP = {
  host: 'mx1.example.test',
  port: 587,
  senderAddress: 'noreply@mail.example.test',
  senderName: 'EXAMPLE',
};

const withSmtp = (smtp: unknown = SMTP) =>
  desiredState(validateConfig({ hostnames: HOSTNAMES, tenants: TWO_TENANTS, smtp }));

function problemsOf(smtp: unknown): readonly string[] {
  try {
    validateConfig({ hostnames: HOSTNAMES, tenants: [], smtp });
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the smtp block of the configuration', () => {
  it('is optional, and when given defaults tls on and keeps the validated values', () => {
    expect(validateConfig({ hostnames: HOSTNAMES, tenants: [] }).smtp).toBeUndefined();
    expect(validateConfig({ hostnames: HOSTNAMES, tenants: [], smtp: SMTP }).smtp).toEqual({
      ...SMTP,
      tls: true,
    });
  });

  it.each([
    ['password', { ...SMTP, password: 'x' }],
    ['user', { ...SMTP, user: 'x' }],
    ['a secret-like key', { ...SMTP, apiSecret: 'x' }],
  ])('refuses %s in the document, so it can be committed and logged', (_why, smtp) => {
    expect(problemsOf(smtp).join(' ')).toContain('is not accepted here');
  });

  it('refuses an unknown setting', () => {
    expect(problemsOf({ ...SMTP, retries: 3 })).toEqual(['smtp.retries is not a known setting']);
  });

  it('refuses turning tls off for a real mail host, in every spelling of one', () => {
    expect(problemsOf({ ...SMTP, tls: false }).join(' ')).toContain('smtp.host');
    expect(problemsOf({ ...SMTP, tls: false, host: '10.0.0.1' }).join(' ')).toContain('smtp.host');
    expect(problemsOf({ ...SMTP, tls: false, host: 'mx1.example.test' }).join(' ')).toContain(
      'smtp.host'
    );
  });

  it('allows plaintext only to a single-label host, which cannot be a real mail host', () => {
    const config = validateConfig({
      hostnames: HOSTNAMES,
      tenants: [],
      smtp: { ...SMTP, host: 'localhost', port: 2525, tls: false },
    });
    expect(config.smtp?.tls).toBe(false);
    expect(config.smtp?.port).toBe(2525);
  });

  it('refuses a single-label host while tls is on', () => {
    expect(problemsOf({ ...SMTP, host: 'localhost' }).join(' ')).toContain('smtp.host');
  });

  it.each([25, 465, 2525, 0, 587.5, '587'])('refuses port %j while tls is on', (port) => {
    expect(problemsOf({ ...SMTP, port }).length).toBeGreaterThan(0);
  });

  it.each([
    'noreply',
    'a@b@c.example.test',
    '@mail.example.test',
    'No Reply@mail.example.test',
    'noreply@Mail.Example.test',
    'noreply@localhost',
    'noreply@10.0.0.1',
    'x\n@mail.example.test',
    42,
  ])('refuses the sender address %j', (senderAddress) => {
    expect(problemsOf({ ...SMTP, senderAddress }).length).toBeGreaterThan(0);
  });

  it.each(['', '   ', 'X\r\nBcc: a@b.test', 'A <b@c.test>', 'say "hi"', 'x'.repeat(101), 7])(
    'refuses the sender name %j, which could break out of a header',
    (senderName) => {
      expect(problemsOf({ ...SMTP, senderName }).length).toBeGreaterThan(0);
    }
  );

  it('refuses a block that is not an object, and a non-boolean tls', () => {
    expect(problemsOf('x')).toEqual([
      'smtp must be an object with host, port, senderAddress and senderName',
    ]);
    expect(problemsOf({ ...SMTP, tls: 'yes' })).toContain('smtp.tls must be true or false');
  });

  it('is refused by the state invariants if built without the config check', () => {
    const state = withSmtp();
    expect(() =>
      reconcile(
        new FakeZitadel(),
        { ...state, smtp: { ...SMTP, host: 'localhost', tls: true } },
        { smtpPassword: 'p' }
      )
    ).rejects.toThrow(/smtp.host must be a DNS name/);
  });
});

describe('the SMTP password file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smtp-pw-'));
  const file = (name: string, content: string | Buffer, mode = 0o600) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  };

  it('reads the value and drops one trailing line ending, nothing else', () => {
    expect(readSmtpPassword(file('a', 'abc123XYZ\n'))).toBe('abc123XYZ');
    expect(readSmtpPassword(file('b', 'abc123XYZ\r\n'))).toBe('abc123XYZ');
    expect(readSmtpPassword(file('c', 'abc123XYZ'))).toBe('abc123XYZ');
    expect(readSmtpPassword(file('d', 'abc\n\n'.replace('\n\n', '')))).toBe('abc');
  });

  it('accepts a group-readable file and refuses a world-readable one', () => {
    expect(readSmtpPassword(file('g', 'pw1', 0o640))).toBe('pw1');
    expect(() => readSmtpPassword(file('w', 'pw1', 0o604))).toThrow(/readable by everyone/);
  });

  it('refuses empty, spaced, multi-line, non-ASCII and over-long values without echoing them', () => {
    for (const [name, content] of [
      ['e', ''],
      ['f', '\n'],
      ['h', 'has space'],
      ['i', 'two\nlines'],
      ['j', 'café'],
      ['k', 'x'.repeat(300)],
    ] as const) {
      const error = (() => {
        try {
          readSmtpPassword(file(name, content));
        } catch (e) {
          return e as ConfigError;
        }
        throw new Error('expected a refusal');
      })();
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).not.toContain(content.trim() || 'NOTHING-TO-FIND');
    }
  });

  it('refuses a missing path, a directory and a symbolic link', () => {
    expect(() => readSmtpPassword(join(dir, 'nope'))).toThrow(/cannot be opened/);
    expect(() => readSmtpPassword(dir)).toThrow(/not a plain file/);
    const target = file('t', 'pw');
    const link = join(dir, 'link');
    symlinkSync(target, link);
    expect(() => readSmtpPassword(link)).toThrow(/cannot be opened/);
  });
});

describe('the fingerprint', () => {
  const smtp: SmtpConfig = { ...SMTP, tls: true };

  it('changes with the password and with every setting, and carries the marker', () => {
    const base = smtpFingerprint(smtp, 'pw');
    expect(smtpFingerprint(smtp, 'pw2')).not.toBe(base);
    for (const change of [
      { host: 'other.example.test' },
      { port: 25 },
      { senderAddress: 'x@mail.example.test' },
      { senderName: 'OTHER' },
      { tls: false },
    ]) {
      expect(smtpFingerprint({ ...smtp, ...change }, 'pw')).not.toBe(base);
    }
    expect(smtpDescription(smtp, 'pw')).toBe(`${MANAGED_MARK} ${base}`);
  });

  it('never contains the password', () => {
    expect(smtpDescription(smtp, 'a-distinctive-password')).not.toContain('distinctive');
  });

  it('recognises only its own marker', () => {
    expect(isManaged(MANAGED_MARK)).toBe(true);
    expect(isManaged(`${MANAGED_MARK} abc`)).toBe(true);
    expect(isManaged(`${MANAGED_MARK}x`)).toBe(false);
    expect(isManaged('added by hand')).toBe(false);
    expect(isManaged('')).toBe(false);
  });
});

describe('reconciling the mail provider', () => {
  it('creates it, activates it, and a second run writes nothing', async () => {
    const fake = new FakeZitadel();
    const first = await reconcile(fake, withSmtp(), { smtpPassword: 'pw-one' });
    const smtp = first.actions.find((a) => a.kind === 'smtp');
    expect(smtp).toEqual({ kind: 'smtp', name: SMTP.senderAddress, status: 'created' });
    const [stored] = [...fake.smtp.values()];
    expect(fake.smtp.size).toBe(1);
    expect(stored).toMatchObject({
      active: true,
      host: 'mx1.example.test:587',
      tls: true,
      user: SMTP.senderAddress,
      senderAddress: SMTP.senderAddress,
      password: 'pw-one',
    });
    const writes = fake.writes;
    const second = await reconcile(fake, withSmtp(), { smtpPassword: 'pw-one' });
    expect(fake.writes).toBe(writes);
    expect(second.actions.every((a) => a.status === 'unchanged')).toBe(true);
  });

  it('puts the account name as the sender address, never a separate user', async () => {
    const fake = new FakeZitadel();
    await reconcile(fake, withSmtp(), { smtpPassword: 'p' });
    expect([...fake.smtp.values()][0]?.user).toBe(SMTP.senderAddress);
  });

  it('replaces the provider when only the password file changed, and removes the old one', async () => {
    const fake = new FakeZitadel();
    await reconcile(fake, withSmtp(), { smtpPassword: 'pw-one' });
    const result = await reconcile(fake, withSmtp(), { smtpPassword: 'pw-two' });
    expect(result.actions.find((a) => a.kind === 'smtp')?.status).toBe('updated');
    expect(fake.smtp.size).toBe(1);
    const [only] = [...fake.smtp.values()];
    expect(only?.password).toBe('pw-two');
    expect(only?.active).toBe(true);
    const writes = fake.writes;
    await reconcile(fake, withSmtp(), { smtpPassword: 'pw-two' });
    expect(fake.writes).toBe(writes);
  });

  it('replaces the provider when a setting changed', async () => {
    const fake = new FakeZitadel();
    await reconcile(fake, withSmtp(), { smtpPassword: 'p' });
    await reconcile(fake, withSmtp({ ...SMTP, senderName: 'RENAMED' }), { smtpPassword: 'p' });
    expect(fake.smtp.size).toBe(1);
    expect([...fake.smtp.values()][0]?.senderName).toBe('RENAMED');
  });

  it('replaces a provider whose settings were edited by hand but kept the description', async () => {
    const fake = new FakeZitadel();
    await reconcile(fake, withSmtp(), { smtpPassword: 'p' });
    const [id] = [...fake.smtp.keys()];
    fake.smtp.set(id!, { ...fake.smtp.get(id!)!, host: 'evil.example.test:587' });
    const result = await reconcile(fake, withSmtp(), { smtpPassword: 'p' });
    expect(result.actions.find((a) => a.kind === 'smtp')?.status).toBe('updated');
    expect([...fake.smtp.values()][0]?.host).toBe('mx1.example.test:587');
  });

  it('adopts an inactive provider left by a run that stopped before activating, without a second one', async () => {
    const fake = new FakeZitadel();
    const state = withSmtp();
    const created = await fake.createSmtp(state.smtp!, 'pw', smtpDescription(state.smtp!, 'pw'));
    await reconcile(fake, state, { smtpPassword: 'pw' });
    expect(fake.smtp.size).toBe(1);
    expect(fake.smtp.get(created.id)?.active).toBe(true);
  });

  it('cleans up old providers left by a run that stopped after activating', async () => {
    const fake = new FakeZitadel();
    const state = withSmtp();
    await fake.createSmtp(state.smtp!, 'old', smtpDescription(state.smtp!, 'old'));
    await reconcile(fake, state, { smtpPassword: 'new' });
    const current = await fake.createSmtp(state.smtp!, 'x', smtpDescription(state.smtp!, 'new'));
    expect(fake.smtp.size).toBe(2);
    await fake.activateSmtp(current.id);
    const result = await reconcile(fake, state, { smtpPassword: 'new' });
    expect(result.actions.find((a) => a.kind === 'smtp')?.status).toBe('updated');
    expect(fake.smtp.size).toBe(1);
  });

  it('reports a hand-added active provider as drift and touches nothing', async () => {
    const fake = new FakeZitadel();
    const state = withSmtp();
    const foreign = await fake.createSmtp(state.smtp!, 'hand', 'added by hand');
    await fake.activateSmtp(foreign.id);
    const before = JSON.stringify([...fake.smtp.entries()]);
    const result = await reconcile(fake, state, { smtpPassword: 'p' });
    expect(result.drift).toBe(true);
    expect(result.actions.find((a) => a.kind === 'smtp')?.status).toBe('drift');
    expect(JSON.stringify([...fake.smtp.entries()])).toBe(before);
    expect(fake.smtp.size).toBe(1);
  });

  it('never deletes a hand-added inactive provider', async () => {
    const fake = new FakeZitadel();
    const state = withSmtp();
    const foreign = await fake.createSmtp(state.smtp!, 'hand', 'added by hand');
    await reconcile(fake, state, { smtpPassword: 'p' });
    expect(fake.smtp.has(foreign.id)).toBe(true);
    expect(fake.smtp.size).toBe(2);
  });

  it('refuses a missing password, and a password with nothing to use it', async () => {
    await expect(reconcile(new FakeZitadel(), withSmtp())).rejects.toThrow(/no password/);
    await expect(
      reconcile(
        new FakeZitadel(),
        desiredState(validateConfig({ hostnames: HOSTNAMES, tenants: [] })),
        { smtpPassword: 'p' }
      )
    ).rejects.toThrow(/smtp is not configured/);
  });

  it('leaves the instance without any provider when the configuration names none', async () => {
    const fake = new FakeZitadel();
    await reconcile(
      fake,
      desiredState(validateConfig({ hostnames: HOSTNAMES, tenants: TWO_TENANTS }))
    );
    expect(fake.smtp.size).toBe(0);
  });

  it('never puts the password in an action or an error', async () => {
    const fake = new FakeZitadel();
    const result = await reconcile(fake, withSmtp(), { smtpPassword: 'S3CRET-VALUE' });
    expect(JSON.stringify(result)).not.toContain('S3CRET-VALUE');
    expect([...fake.smtp.values()][0]?.description).not.toContain('S3CRET-VALUE');
  });
});

describe('the mail provider over the management API', () => {
  function harness(answer: (call: { url: string; method: string; body: unknown }) => unknown) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetch: FetchLike = async (url, init) => {
      const call = { url, method: init.method, body: JSON.parse(init.body) as unknown };
      calls.push(call);
      return { ok: true, status: 200, json: async () => answer(call) };
    };
    return {
      calls,
      client: managementClient({ baseUrl: 'http://z.test', token: () => 'T', fetch }),
    };
  }

  it('lists providers, with the active one marked and the password absent', async () => {
    const { client, calls } = harness(() => ({
      result: [
        {
          id: '1',
          host: 'h:587',
          senderAddress: 'a@b.test',
          senderName: 'N',
          user: 'a@b.test',
          tls: true,
          description: 'd',
          state: 'SMTP_CONFIG_ACTIVE',
        },
        { id: '2', host: 'h:587', senderAddress: 'a@b.test', state: 'SMTP_CONFIG_INACTIVE' },
      ],
    }));
    const listed = await client.listSmtp();
    expect(calls[0]?.url).toBe('http://z.test/admin/v1/smtp/_search');
    expect(listed[0]).toMatchObject({ id: '1', active: true, tls: true, description: 'd' });
    expect(listed[1]).toMatchObject({
      id: '2',
      active: false,
      tls: false,
      user: '',
      description: '',
    });
    expect(JSON.stringify(listed)).not.toContain('password');
  });

  it('creates with host:port and the sender as the account, activates and deletes by id', async () => {
    const { client, calls } = harness((call) =>
      call.method === 'POST' && call.url.endsWith('/smtp') ? { id: 'n1' } : {}
    );
    const made = await client.createSmtp(
      { host: 'mx.test', port: 587, senderAddress: 'a@b.test', senderName: 'N', tls: true },
      'PW',
      'desc'
    );
    expect(made).toEqual({ id: 'n1' });
    expect(calls[0]).toEqual({
      url: 'http://z.test/admin/v1/smtp',
      method: 'POST',
      body: {
        senderAddress: 'a@b.test',
        senderName: 'N',
        tls: true,
        host: 'mx.test:587',
        user: 'a@b.test',
        password: 'PW',
        description: 'desc',
      },
    });
    await client.activateSmtp('n/1');
    await client.deleteSmtp('n1');
    expect(calls[1]?.url).toBe('http://z.test/admin/v1/smtp/n%2F1/_activate');
    expect(calls[2]).toMatchObject({ url: 'http://z.test/admin/v1/smtp/n1', method: 'DELETE' });
  });
});
