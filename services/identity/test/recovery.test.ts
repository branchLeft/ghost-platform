import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ORG_NAME } from '../src/desired.js';
import {
  generateOneTimePassword,
  loopbackOrigin,
  recoverOwner,
  RecoveryRefused,
} from '../src/recovery.js';
import type { RecoveryDeps, RecoveryFetch, RecoveryOptions } from '../src/recovery.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const TOKEN = 'RECOVERY-T0KEN-VALUE';
const USER = '300000000000000001';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: string;
}

interface World {
  orgName: string;
  orgId: string;
  userOrgId: string;
  state: string;
  human: boolean;
  failPath?: string;
  rawFail?: string;
}

let dir: string;
let calls: Call[];
let world: World;

function stage(file: string, content = TOKEN, ageSeconds = 10, mode = 0o600): void {
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  const when = new Date(NOW.getTime() - ageSeconds * 1000);
  utimesSync(file, when, when);
}

function makeFetch(): RecoveryFetch {
  return async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      redirect: init.redirect,
    });
    if (world.rawFail === path) throw new Error('connection refused');
    if (world.failPath === path) return { ok: false, status: 403, json: async () => ({}) };
    if (path === '/management/v1/orgs/me') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ org: { id: world.orgId, name: world.orgName } }),
      };
    }
    if (path.startsWith('/v2/users/') && init.method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: {
            userId: USER,
            state: world.state,
            details: { resourceOwner: world.userOrgId },
            ...(world.human ? { human: {} } : { machine: {} }),
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

function options(over: Partial<RecoveryOptions> = {}): RecoveryOptions {
  return {
    baseUrl: 'http://127.0.0.1:8080',
    instanceHost: 'id.example.test',
    userId: USER,
    credentialFile: join(dir, 'token'),
    auditFile: join(dir, 'audit.log'),
    ...over,
  };
}

function deps(over: Partial<RecoveryDeps> = {}): RecoveryDeps {
  return {
    fetch: makeFetch(),
    now: () => NOW,
    uid: process.getuid?.() ?? 0,
    actor: 'operator',
    stdoutIsTerminal: true,
    ...over,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<RecoveryRefused> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryRefused);
    return error as RecoveryRefused;
  }
  throw new Error('expected a refusal');
}

function audit(): Record<string, unknown>[] {
  const file = join(dir, 'audit.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recovery-'));
  calls = [];
  world = {
    orgName: OWNER_ORG_NAME,
    orgId: 'org-owner',
    userOrgId: 'org-owner',
    state: 'USER_STATE_ACTIVE',
    human: true,
  };
  stage(join(dir, 'token'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recoverOwner, the working path', () => {
  it('sets a one-time password that must be changed, using only loopback, with the instance host', async () => {
    const result = await recoverOwner(options(), deps());
    expect(result.actions).toEqual(['password-set']);
    expect(result.oneTimePassword).toHaveLength(24);
    const set = calls.at(-1)!;
    expect(set.url).toBe(`http://127.0.0.1:8080/v2/users/${USER}/password`);
    expect(set.body).toEqual({
      newPassword: { password: result.oneTimePassword, changeRequired: true },
    });
    for (const call of calls) {
      expect(call.url.startsWith('http://127.0.0.1:8080/')).toBe(true);
      expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(call.headers['x-zitadel-instance-host']).toBe('id.example.test');
      expect(call.redirect).toBe('error');
    }
  });

  it('works when nothing but the sign-in service is reachable: no portal, console or other host is called', async () => {
    await recoverOwner(options(), deps());
    expect(new Set(calls.map((c) => new URL(c.url).host))).toEqual(new Set(['127.0.0.1:8080']));
  });

  it('accepts an IPv6 loopback and https', async () => {
    await recoverOwner(options({ baseUrl: 'https://[::1]:8443' }), deps());
    expect(calls[0]!.url.startsWith('https://[::1]:8443/')).toBe(true);
  });

  it('unlocks a locked owner before setting the password', async () => {
    world.state = 'USER_STATE_LOCKED';
    const result = await recoverOwner(options(), deps());
    expect(result.actions).toEqual(['unlocked', 'password-set']);
    expect(calls.some((c) => c.url.endsWith(`/management/v1/users/${USER}/_unlock`))).toBe(true);
  });

  it('reactivates an inactive owner', async () => {
    world.state = 'USER_STATE_INACTIVE';
    const result = await recoverOwner(options(), deps());
    expect(result.actions).toEqual(['reactivated', 'password-set']);
  });
});

describe('recoverOwner, single use and audit', () => {
  it('consumes the staged credential so a second run is refused', async () => {
    await recoverOwner(options(), deps());
    expect(existsSync(join(dir, 'token'))).toBe(false);
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('credential-missing');
  });

  it('writes a begin and an end entry carrying a fingerprint and never the credential or the password', async () => {
    const result = await recoverOwner(options(), deps());
    const entries = audit();
    expect(entries.map((e) => e['event'])).toEqual(['recovery.begin', 'recovery.end']);
    expect(entries[1]!['outcome']).toBe('recovered');
    expect(entries[0]).toMatchObject({ actor: 'operator', user: USER, at: NOW.toISOString() });
    expect(String(entries[0]!['credential'])).toMatch(/^[0-9a-f]{8}$/);
    const raw = readFileSync(join(dir, 'audit.log'), 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(result.oneTimePassword);
  });

  it('records the refusal code of a failed run in the end entry', async () => {
    world.orgName = 'tenant-a';
    await refusal(() => recoverOwner(options(), deps()));
    expect(audit().map((e) => e['outcome'])).toEqual([undefined, 'wrong-organisation']);
  });

  it('records a generic outcome when the failure is not a refusal', async () => {
    const boom: RecoveryFetch = async () => {
      throw new TypeError('x');
    };
    // The fetch wrapper turns transport faults into a refusal, so force a bare error through json().
    const odd: RecoveryFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad body');
      },
    });
    await refusal(() => recoverOwner(options(), deps({ fetch: boom })));
    stage(join(dir, 'token'));
    await refusal(() => recoverOwner(options(), deps({ fetch: odd })));
    expect(
      audit()
        .filter((e) => e['event'] === 'recovery.end')
        .map((e) => e['outcome'])
    ).toEqual(['api-error', 'api-error']);
  });

  it('refuses without touching the credential when the audit file cannot be written', async () => {
    const result = await refusal(() =>
      recoverOwner(options({ auditFile: join(dir, 'missing-dir', 'audit.log') }), deps())
    );
    expect(result.code).toBe('audit-unwritable');
    expect(existsSync(join(dir, 'token'))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses an audit file that is open to other users', async () => {
    writeFileSync(join(dir, 'audit.log'), '', { mode: 0o644 });
    chmodSync(join(dir, 'audit.log'), 0o644);
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('audit-unwritable');
    expect(existsSync(join(dir, 'token'))).toBe(true);
  });

  it('refuses an audit file that is a symlink', async () => {
    writeFileSync(join(dir, 'elsewhere'), '', { mode: 0o600 });
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'audit.log'));
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('audit-unwritable');
    expect(readFileSync(join(dir, 'elsewhere'), 'utf8')).toBe('');
  });

  it('does not act when the credential cannot be removed', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'recovery-audit-'));
    chmodSync(dir, 0o500);
    try {
      const result = await refusal(() =>
        recoverOwner(options({ auditFile: join(auditDir, 'audit.log') }), deps())
      );
      expect(result.code).toBe('consume-failed');
      expect(calls).toHaveLength(0);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(auditDir, { recursive: true, force: true });
    }
  });
});

describe('recoverOwner, the conditions that must hold', () => {
  it('refuses a stale credential', async () => {
    stage(join(dir, 'token'), TOKEN, 1801);
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('credential-stale');
    expect(calls).toHaveLength(0);
    expect(existsSync(join(dir, 'token'))).toBe(true);
  });

  it('honours a shorter age limit and refuses a longer one than the cap', async () => {
    stage(join(dir, 'token'), TOKEN, 120);
    expect(
      (await refusal(() => recoverOwner(options({ maxCredentialAgeSeconds: 60 }), deps()))).code
    ).toBe('credential-stale');
    for (const bad of [0, 3601, 1.5, Number.NaN]) {
      expect(
        (await refusal(() => recoverOwner(options({ maxCredentialAgeSeconds: bad }), deps()))).code
      ).toBe('bad-max-age');
    }
  });

  it('refuses a credential dated in the future', async () => {
    stage(join(dir, 'token'), TOKEN, -300);
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('credential-future');
  });

  it('refuses a credential readable by group or others', async () => {
    stage(join(dir, 'token'), TOKEN, 10, 0o640);
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('credential-mode');
  });

  it('refuses a credential owned by another user', async () => {
    const other = (process.getuid?.() ?? 0) + 1;
    expect((await refusal(() => recoverOwner(options(), deps({ uid: other })))).code).toBe(
      'credential-owner'
    );
  });

  it('refuses a symlink to a good credential', async () => {
    stage(join(dir, 'real'));
    rmSync(join(dir, 'token'));
    symlinkSync(join(dir, 'real'), join(dir, 'token'));
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe(
      'credential-not-regular'
    );
  });

  it('refuses a missing and an empty credential', async () => {
    rmSync(join(dir, 'token'));
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('credential-missing');
    stage(join(dir, 'token'), '  \n');
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('credential-empty');
  });

  it('refuses when stdout is not a terminal, before reading anything', async () => {
    const result = await refusal(() => recoverOwner(options(), deps({ stdoutIsTerminal: false })));
    expect(result.code).toBe('not-a-terminal');
    expect(existsSync(join(dir, 'token'))).toBe(true);
    expect(audit()).toEqual([]);
  });

  it('refuses a bad instance host and a bad user id', async () => {
    expect(
      (await refusal(() => recoverOwner(options({ instanceHost: 'id.example.test:443' }), deps())))
        .code
    ).toBe('bad-instance-host');
    for (const userId of ['', '../x', 'a b', 'x'.repeat(65)]) {
      expect((await refusal(() => recoverOwner(options({ userId }), deps()))).code).toBe(
        'bad-user-id'
      );
    }
  });

  it('refuses a credential from a tenant organisation or a user outside the owner organisation', async () => {
    world.orgName = 'tenant-a';
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('wrong-organisation');
    stage(join(dir, 'token'));
    world.orgName = OWNER_ORG_NAME;
    world.userOrgId = 'org-tenant';
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('wrong-organisation');
    expect(calls.filter((c) => c.url.endsWith('/password'))).toHaveLength(0);
  });

  it('refuses a machine user and a malformed organisation answer', async () => {
    world.human = false;
    expect((await refusal(() => recoverOwner(options(), deps()))).code).toBe('not-human');
    stage(join(dir, 'token'));
    const noOrg: RecoveryFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    expect((await refusal(() => recoverOwner(options(), deps({ fetch: noOrg })))).code).toBe(
      'wrong-organisation'
    );
    stage(join(dir, 'token'));
    const noUser: RecoveryFetch = async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        new URL(url).pathname === '/management/v1/orgs/me'
          ? { org: { id: 'o', name: OWNER_ORG_NAME } }
          : {},
    });
    expect((await refusal(() => recoverOwner(options(), deps({ fetch: noUser })))).code).toBe(
      'wrong-organisation'
    );
  });

  it('turns a sign-in service refusal or an unreachable service into a fixed message', async () => {
    world.failPath = '/management/v1/orgs/me';
    const denied = await refusal(() => recoverOwner(options(), deps()));
    expect(denied.code).toBe('api-error');
    expect(denied.message).toContain('403');
    expect(denied.message).not.toContain(TOKEN);
    stage(join(dir, 'token'));
    world.failPath = undefined;
    world.rawFail = '/management/v1/orgs/me';
    const down = await refusal(() => recoverOwner(options(), deps()));
    expect(down.message).not.toContain('connection refused');
  });

  it('refuses a non-object answer', async () => {
    const list: RecoveryFetch = async () => ({ ok: true, status: 200, json: async () => [] });
    expect((await refusal(() => recoverOwner(options(), deps({ fetch: list })))).code).toBe(
      'api-error'
    );
  });
});

describe('loopbackOrigin', () => {
  it.each(['http://127.0.0.1:8080', 'http://127.0.0.1', 'https://[::1]:8443/'])(
    'accepts %s',
    (url) => {
      expect(() => loopbackOrigin(url)).not.toThrow();
    }
  );

  it.each([
    'http://10.0.0.5:8080',
    'http://localhost:8080',
    'http://127.0.0.1.example.test',
    'http://127.0.0.1@example.test',
    'http://user:pw@127.0.0.1',
    'http://127.0.0.2',
    'http://0.0.0.0:8080',
    'ftp://127.0.0.1',
    'http://127.0.0.1/path',
    'http://127.0.0.1/?q=1',
    'https://id.example.test',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(() => loopbackOrigin(url)).toThrow(RecoveryRefused);
  });

  it('is refused before any file is read or any call made', async () => {
    const result = await refusal(() =>
      recoverOwner(options({ baseUrl: 'https://id.example.test' }), deps())
    );
    expect(result.code).toBe('not-loopback');
    expect(calls).toHaveLength(0);
    expect(existsSync(join(dir, 'token'))).toBe(true);
    expect(audit()).toEqual([]);
  });
});

describe('generateOneTimePassword', () => {
  it('has one of each character class and is not repeated', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const password = generateOneTimePassword();
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[-_.!#%+=]/);
      seen.add(password);
    }
    expect(seen.size).toBe(50);
  });

  it('honours a length', () => {
    expect(generateOneTimePassword(40)).toHaveLength(40);
  });
});
