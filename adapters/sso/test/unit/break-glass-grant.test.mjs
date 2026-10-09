import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCKER_TIMEOUT_MS,
  EXPIRE_TIMER_UNIT,
  expire,
  findTenantContainer,
  grant,
  GRANT_WINDOW_SECONDS,
  GrantRefusedError,
  main,
  parseGrantArgs,
  recreateIfDeleted,
  removeStateIfSame,
  revoke,
  runInContainer,
  SECOND_PURGE_DELAY_MS,
  stateFingerprint,
  status,
} from '../../scripts/break-glass-grant.mjs';
import { ActiveExistingRowError } from '../../scripts/provision-support-account.mjs';

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const SUPPORT = 'support@platform.example';
let dir;

/** A fake container whose config names SUPPORT, honouring an expected identity as the real one does. */
function fakeDeps(overrides = {}) {
  let now = T0;
  const calls = [];
  const deps = {
    stateDir: path.join(dir, 'grants'),
    recordLog: path.join(dir, 'grants.jsonl'),
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
    timerActive: () => true,
    findContainer: (tenant) => `${tenant}-ghost-a-1`,
    run: vi.fn(({ action, expect }) => {
      calls.push(action);
      if (expect && expect !== SUPPORT) {
        throw new GrantRefusedError(`${expect} is not this tenant's configured support identity`);
      }
      if (action === 'identity') return { identity: SUPPORT };
      if (action === 'revoke') {
        return {
          identity: SUPPORT,
          found: true,
          id: 'u1',
          previousStatus: 'active',
          sessionsPurged: 1,
        };
      }
      return {
        identity: SUPPORT,
        id: 'u1',
        previousStatus: action === 'check' ? 'active' : 'inactive',
      };
    }),
    recreate: vi.fn(() => ({ created: false })),
    betweenPurges: vi.fn(async () => {
      calls.push('between');
    }),
    calls,
    ...overrides,
  };
  return deps;
}

const records = () =>
  fs
    .readFileSync(path.join(dir, 'grants.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const request = (lane = 'incident', identity = undefined) => ({
  lane,
  tenant: 'tenant-zero',
  identity,
  reason: 'readers see errors',
  reference: 'workspace#0',
});

const stateFile = (deps, tenant = 'tenant-zero') => path.join(deps.stateDir, `${tenant}.json`);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-grant-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('parseGrantArgs', () => {
  const full = ['--lane', 'incident', '--tenant', 't', '--reason', 'r', '--reference', 'ref'];

  it('parses a grant, with --identity optional', () => {
    expect(parseGrantArgs(['grant', ...full])).toMatchObject({
      command: 'grant',
      lane: 'incident',
      tenant: 't',
    });
    expect(parseGrantArgs(['grant', ...full, '--identity', 's@x.example']).identity).toBe(
      's@x.example'
    );
  });

  it('refuses a lane other than consented or incident', () => {
    expect(() => parseGrantArgs(['grant', '--lane', 'standing', ...full.slice(2)])).toThrow(
      /--lane/
    );
  });

  it('refuses a grant missing its reference', () => {
    expect(() => parseGrantArgs(['grant', ...full.slice(0, 6)])).toThrow(/needs --reference/);
  });

  it('refuses a flag the command does not take: revoke never takes an identity', () => {
    expect(() =>
      parseGrantArgs(['revoke', '--tenant', 't', '--reason', 'r', '--identity', 'a@b.c'])
    ).toThrow(/does not take --identity/);
    expect(() => parseGrantArgs(['grant', ...full, '--hours', '8'])).toThrow(/unrecognised/);
  });

  it('refuses a tenant that is not a slug, and an identity that is not an email', () => {
    expect(() => parseGrantArgs(['revoke', '--tenant', '../etc', '--reason', 'r'])).toThrow(
      /--tenant/
    );
    expect(() => parseGrantArgs(['grant', ...full, '--identity', 'nobody'])).toThrow(/--identity/);
  });

  it('refuses a multi-line reason', () => {
    expect(() => parseGrantArgs(['revoke', '--tenant', 't', '--reason', 'a\nb'])).toThrow(
      /--reason/
    );
  });

  it('parses expire and status with no flags, and refuses other commands', () => {
    expect(parseGrantArgs(['expire'])).toEqual({ command: 'expire' });
    expect(parseGrantArgs(['status'])).toEqual({ command: 'status' });
    expect(() => parseGrantArgs(['extend'])).toThrow(/grant, revoke, expire or status/);
  });
});

describe('grant: the account is the one in the tenant config', () => {
  it('refuses a typed identity that is not the configured one, before anything is written', async () => {
    const deps = fakeDeps();
    await expect(grant(request('incident', 'staff-admin@tenant.example'), deps)).rejects.toThrow(
      /not this tenant's configured support identity/
    );
    expect(deps.calls).toEqual(['identity']);
    expect(fs.existsSync(stateFile(deps))).toBe(false);
    expect(deps.recreate).not.toHaveBeenCalled();
  });

  it('records the configured identity, never a typed one', async () => {
    const deps = fakeDeps();
    const opened = await grant(request('consented'), deps);
    expect(opened.identity).toBe(SUPPORT);
    expect(deps.run.mock.calls.slice(1).map(([r]) => r.expect)).toEqual([SUPPORT]);
  });

  it('accepts a typed identity equal to the configured one', async () => {
    const deps = fakeDeps();
    await expect(grant(request('consented', SUPPORT), deps)).resolves.toMatchObject({
      identity: SUPPORT,
    });
  });
});

describe('grant', () => {
  it('refuses to open anything when the expire timer is not active', async () => {
    const deps = fakeDeps({ timerActive: () => false });
    await expect(grant(request(), deps)).rejects.toThrow(EXPIRE_TIMER_UNIT);
    expect(deps.run).not.toHaveBeenCalled();
    expect(fs.existsSync(deps.stateDir)).toBe(false);
  });

  it('incident lane: activates an existing account, with a four-hour deadline', async () => {
    const deps = fakeDeps();
    const opened = await grant(request(), deps);
    expect(deps.recreate).not.toHaveBeenCalled();
    expect(deps.calls).toEqual(['identity', 'activate']);
    expect(opened).toMatchObject({ recreated: false, previousStatus: 'inactive' });
    expect(Date.parse(opened.deadline) - T0).toBe(GRANT_WINDOW_SECONDS * 1000);
    expect(GRANT_WINDOW_SECONDS).toBe(14400);
    expect(records()).toMatchObject([{ event: 'opened', lane: 'incident', recreated: false }]);
    expect(fs.statSync(stateFile(deps)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(deps.stateDir)).toEqual(['tenant-zero.json']);
  });

  it('incident lane: recreates a deleted account through provisioning, then activates it', async () => {
    let absent = true;
    const deps = fakeDeps({ recreate: vi.fn(() => ({ created: true })) });
    const base = deps.run;
    deps.run = vi.fn((r) => {
      if (r.action === 'activate' && absent) {
        absent = false;
        deps.calls.push('activate');
        return { identity: SUPPORT, absent: true };
      }
      return base(r);
    });
    const opened = await grant(request(), deps);
    expect(deps.recreate).toHaveBeenCalledWith({
      container: 'tenant-zero-ghost-a-1',
      identity: SUPPORT,
    });
    expect(deps.calls).toEqual(['identity', 'activate', 'activate']);
    expect(opened.recreated).toBe(true);
  });

  it('incident lane: fails if the recreated account is still absent, keeping the clock', async () => {
    const deps = fakeDeps();
    deps.run = vi.fn((r) =>
      r.action === 'identity' ? { identity: SUPPORT } : { identity: SUPPORT, absent: true }
    );
    await expect(grant(request(), deps)).rejects.toThrow(/could not be recreated/);
    expect(status(deps)).toHaveLength(1);
  });

  it('consented lane: only checks, never writes the account, and starts the same clock', async () => {
    const deps = fakeDeps();
    const opened = await grant(request('consented'), deps);
    expect(deps.recreate).not.toHaveBeenCalled();
    expect(deps.calls).toEqual(['identity', 'check']);
    expect(Date.parse(opened.deadline) - T0).toBe(GRANT_WINDOW_SECONDS * 1000);
  });

  it('consented lane: a refused check leaves no clock behind, since nothing was opened', async () => {
    const deps = fakeDeps();
    const base = deps.run;
    deps.run = vi.fn((r) => {
      if (r.action === 'check')
        throw new GrantRefusedError('the tenant has not un-suspended the support account');
      return base(r);
    });
    await expect(grant(request('consented'), deps)).rejects.toThrow(/not un-suspended/);
    expect(status(deps)).toEqual([]);
  });

  it('incident lane: a failure keeps the clock, so the timer still closes what may have opened', async () => {
    const deps = fakeDeps();
    const base = deps.run;
    deps.run = vi.fn((r) => {
      if (r.action === 'activate') throw new Error('docker exec activate failed');
      return base(r);
    });
    await expect(grant(request(), deps)).rejects.toThrow(/activate failed/);
    expect(status(deps)).toHaveLength(1);
  });

  it('writes the clock before it touches the account', async () => {
    const deps = fakeDeps();
    const base = deps.run;
    deps.run = vi.fn((r) => {
      if (r.action !== 'identity') expect(fs.existsSync(stateFile(deps))).toBe(true);
      return base(r);
    });
    await grant(request(), deps);
    expect(deps.run).toHaveBeenCalledTimes(2);
  });

  it('refuses a second grant while one is open', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    await expect(grant(request(), deps)).rejects.toThrow(/already open until/);
  });

  it('never overwrites a grant another run wrote between the check and the write', async () => {
    const deps = fakeDeps();
    const theirs = '{"tenant":"tenant-zero","deadline":"2026-10-08T20:00:00.000Z"}\n';
    deps.findContainer = (tenant) => {
      fs.mkdirSync(deps.stateDir, { recursive: true });
      fs.writeFileSync(stateFile(deps), theirs);
      return `${tenant}-ghost-a-1`;
    };
    await expect(grant(request(), deps)).rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(stateFile(deps), 'utf8')).toBe(theirs);
    expect(fs.readdirSync(deps.stateDir)).toEqual(['tenant-zero.json']);
  });

  it('refuses while an unreadable grant state exists, and says to revoke', async () => {
    const deps = fakeDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    fs.writeFileSync(stateFile(deps), '{"tenant":"tenant-zero","dead');
    await expect(grant(request(), deps)).rejects.toThrow(/unreadable.*revoke first/);
  });

  it('refuses with nothing written when the tenant has no running container', async () => {
    const deps = fakeDeps({
      findContainer: () => {
        throw new GrantRefusedError('no running Ghost container');
      },
    });
    await expect(grant(request(), deps)).rejects.toThrow(/no running Ghost container/);
    expect(status(deps)).toEqual([]);
  });
});

describe('revoke (requirement 1: purge twice)', () => {
  it('suspends and purges, waits, suspends and purges again, then writes the closing record', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    deps.calls.length = 0;
    const closing = await revoke({ tenant: 'tenant-zero', reason: 'incident closed' }, deps);
    expect(deps.calls).toEqual(['revoke', 'between', 'revoke']);
    expect(deps.run.mock.calls.slice(-2).map(([r]) => r.expect)).toEqual([undefined, undefined]);
    expect(deps.sleep).toHaveBeenCalledWith(SECOND_PURGE_DELAY_MS);
    expect(SECOND_PURGE_DELAY_MS).toBeGreaterThanOrEqual(2000);
    expect(closing).toMatchObject({
      event: 'closed',
      cause: 'explicit',
      closeReason: 'incident closed',
      identity: SUPPORT,
      stateFound: true,
      identityChanged: false,
      sessionsPurged: [1, 1],
    });
    expect(records().map((r) => r.event)).toEqual(['opened', 'closed']);
    expect(status(deps)).toEqual([]);
  });

  it('closes the configured account with no state file at all', async () => {
    const deps = fakeDeps();
    const closing = await revoke({ tenant: 'tenant-zero', reason: 'state lost' }, deps);
    expect(deps.calls).toEqual(['revoke', 'between', 'revoke']);
    expect(closing).toMatchObject({
      stateFound: false,
      stateUnreadable: null,
      identity: SUPPORT,
      accountFound: true,
    });
  });

  it('closes the configured account when the state file is unreadable, and removes it', async () => {
    const deps = fakeDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    fs.writeFileSync(stateFile(deps), 'garbage');
    const closing = await revoke({ tenant: 'tenant-zero', reason: 'r' }, deps);
    expect(closing.stateUnreadable).toMatch(/not JSON/);
    expect(fs.existsSync(stateFile(deps))).toBe(false);
  });

  it('records when the configured identity changed during the window', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    const state = JSON.parse(fs.readFileSync(stateFile(deps), 'utf8'));
    fs.writeFileSync(
      stateFile(deps),
      JSON.stringify({ ...state, identity: 'old@platform.example' })
    );
    expect((await revoke({ tenant: 'tenant-zero', reason: 'r' }, deps)).identityChanged).toBe(true);
  });

  it('closes a grant whose account the tenant deleted, and records that', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    deps.run = vi.fn(() => ({ identity: SUPPORT, found: false, sessionsPurged: 0 }));
    const closing = await revoke({ tenant: 'tenant-zero', reason: 'r' }, deps);
    expect(closing).toMatchObject({ accountFound: false, previousStatus: null });
  });
});

describe('expire (the four-hour clock)', () => {
  it('leaves a grant open before its deadline', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    deps.advance(GRANT_WINDOW_SECONDS * 1000 - 1);
    expect(await expire(deps)).toEqual({ closed: [], failed: [] });
    expect(status(deps)).toHaveLength(1);
  });

  it('closes it at its deadline, with cause timer', async () => {
    const deps = fakeDeps();
    await grant(request('consented'), deps);
    deps.advance(GRANT_WINDOW_SECONDS * 1000);
    const { closed } = await expire(deps);
    expect(closed).toMatchObject([{ tenant: 'tenant-zero', cause: 'timer', lane: 'consented' }]);
    expect(status(deps)).toEqual([]);
  });

  it('closes an unreadable grant instead of failing, and still closes every other due grant', async () => {
    const deps = fakeDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    fs.writeFileSync(stateFile(deps, 'aaa'), '{"tenant":"aaa","deadl');
    fs.writeFileSync(stateFile(deps, 'ccc'), 'null');
    await grant({ ...request(), tenant: 'bbb' }, deps);
    deps.advance(GRANT_WINDOW_SECONDS * 1000);
    const { closed, failed } = await expire(deps);
    expect(failed).toEqual([]);
    expect(closed.map((c) => [c.tenant, Boolean(c.stateUnreadable)])).toEqual([
      ['aaa', true],
      ['bbb', false],
      ['ccc', true],
    ]);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringMatching(/aaa is unreadable.*closing it now/)
    );
    expect(status(deps)).toEqual([]);
  });

  it('reports a state file that names no tenant, and carries on', async () => {
    const deps = fakeDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    fs.writeFileSync(path.join(deps.stateDir, 'Bad Name.json'), '{}');
    await grant(request(), deps);
    deps.advance(GRANT_WINDOW_SECONDS * 1000);
    const { closed, failed } = await expire(deps);
    expect(failed).toMatchObject([{ tenant: 'Bad Name' }]);
    expect(closed).toHaveLength(1);
  });

  it('keeps the grant and reports the failure when the container is down, so the next run retries', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    deps.advance(GRANT_WINDOW_SECONDS * 1000);
    deps.findContainer = () => {
      throw new GrantRefusedError('no running Ghost container for tenant tenant-zero');
    };
    const result = await expire(deps);
    expect(result.failed).toMatchObject([{ tenant: 'tenant-zero' }]);
    expect(status(deps)).toHaveLength(1);
  });

  it('ignores the temporary files a write leaves for an instant', async () => {
    const deps = fakeDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    fs.writeFileSync(path.join(deps.stateDir, '.tenant-zero.123.tmp'), 'partial');
    expect(await expire(deps)).toEqual({ closed: [], failed: [] });
  });

  it('does nothing when no grant has ever been opened', async () => {
    expect(await expire(fakeDeps())).toEqual({ closed: [], failed: [] });
  });
});

describe('status', () => {
  it('lists an unreadable grant rather than throwing', async () => {
    const deps = fakeDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    fs.writeFileSync(stateFile(deps), '[]');
    expect(status(deps)).toMatchObject([
      { tenant: 'tenant-zero', unreadable: expect.stringMatching(/deadline/) },
    ]);
  });
});

describe('main', () => {
  const out = () => ({
    text: '',
    write(s) {
      this.text += s;
    },
  });

  it('exits 1 when expire could not close a grant, so systemd marks the run failed', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    deps.advance(GRANT_WINDOW_SECONDS * 1000);
    deps.findContainer = () => {
      throw new Error('docker down');
    };
    expect(await main(['expire'], deps, out())).toBe(1);
  });

  it('runs grant, status, revoke and expire', async () => {
    const deps = fakeDeps();
    const flags = ['--tenant', 'tenant-zero', '--reason', 'r', '--reference', 'x'];
    expect(await main(['grant', '--lane', 'consented', ...flags], deps, out())).toBe(0);
    const s = out();
    await main(['status'], deps, s);
    expect(JSON.parse(s.text)).toHaveLength(1);
    expect(await main(['revoke', '--tenant', 'tenant-zero', '--reason', 'done'], deps, out())).toBe(
      0
    );
    expect(await main(['expire'], deps, out())).toBe(0);
  });
});

describe('recreateIfDeleted', () => {
  it('provisions when the account is missing, with a timeout on its docker call', () => {
    const provision = vi.fn((args, execFile) => {
      expect(typeof execFile).toBe('function');
      return { created: true };
    });
    expect(recreateIfDeleted({ container: 'c', identity: 's@x.example' }, provision)).toEqual({
      created: true,
    });
    expect(provision.mock.calls[0][0]).toEqual({ container: 'c', email: 's@x.example' });
  });

  it('treats an account already present and active as present', () => {
    const provision = () => {
      throw new ActiveExistingRowError('active');
    };
    expect(recreateIfDeleted({ container: 'c', identity: 's@x.example' }, provision)).toEqual({
      created: false,
    });
  });

  it('passes any other failure through', () => {
    const provision = () => {
      throw new Error('boom');
    };
    expect(() => recreateIfDeleted({ container: 'c', identity: 's@x.example' }, provision)).toThrow(
      'boom'
    );
  });
});

describe('findTenantContainer', () => {
  it('picks a running Ghost colour by Compose labels, ignoring other services, with a timeout', () => {
    const execFile = vi.fn(
      () => 'tz-ghost-b-1\tghost-b\ntz-sidecar-1\tdrain\ntz-ghost-a-1\tghost-a\n'
    );
    expect(findTenantContainer('tz', execFile)).toBe('tz-ghost-a-1');
    expect(execFile.mock.calls[0][1]).toContain('label=com.docker.compose.project=tz');
    expect(execFile.mock.calls[0][2]).toMatchObject({ timeout: DOCKER_TIMEOUT_MS });
  });

  it('refuses when no Ghost container is running', () => {
    expect(() => findTenantContainer('tz', () => 'tz-sidecar-1\tdrain\n')).toThrow(
      /no running Ghost container/
    );
  });
});

describe('runInContainer', () => {
  it('passes only the action and an expected identity as env, with a timeout', () => {
    const execFile = vi.fn(
      () => `Ghost noise\nBL_BREAK_GLASS {"identity":"${SUPPORT}","id":"u1"}\n`
    );
    expect(
      runInContainer({ container: 'c', action: 'activate', expect: SUPPORT }, execFile)
    ).toEqual({
      identity: SUPPORT,
      id: 'u1',
    });
    const [, argv, options] = execFile.mock.calls[0];
    expect(argv.slice(0, 6)).toEqual([
      'exec',
      '-e',
      'BL_ACTION=activate',
      '-e',
      `BL_EXPECT_IDENTITY=${SUPPORT}`,
      'c',
    ]);
    expect(argv[argv.length - 1]).not.toContain(SUPPORT);
    expect(options).toMatchObject({ timeout: DOCKER_TIMEOUT_MS, killSignal: 'SIGKILL' });
  });

  it('sends no expected identity when none is given', () => {
    const execFile = vi.fn(() => 'BL_BREAK_GLASS {}\n');
    runInContainer({ container: 'c', action: 'revoke' }, execFile);
    expect(execFile.mock.calls[0][1].slice(0, 4)).toEqual(['exec', '-e', 'BL_ACTION=revoke', 'c']);
  });

  it('reads the identity from the tenant config inside the container, never from env', async () => {
    const { INNER_SCRIPT } = await import('../../scripts/break-glass-grant.mjs');
    expect(INNER_SCRIPT).toContain("config.get('adapters:sso:BreakGlassSSO:supportIdentity')");
    expect(INNER_SCRIPT).not.toContain('BL_IDENTITY');
  });

  it('turns an inner refusal into GrantRefusedError', () => {
    const execFile = () => {
      const e = new Error('exit 1');
      e.stderr = 'BL_BREAK_GLASS_REFUSED the account holds the Owner role; it is never suspended\n';
      throw e;
    };
    expect(() => runInContainer({ container: 'c', action: 'revoke' }, execFile)).toThrow(
      GrantRefusedError
    );
  });

  it('reports any other failure with its stderr', () => {
    const execFile = () => {
      const e = new Error('exit 1');
      e.stderr = 'Error: No such container: c';
      throw e;
    };
    expect(() => runInContainer({ container: 'c', action: 'revoke' }, execFile)).toThrow(
      /No such container/
    );
  });

  it('refuses output with no result line', () => {
    expect(() => runInContainer({ container: 'c', action: 'check' }, () => 'nothing')).toThrow(
      /printed no result/
    );
  });
});

describe('closing a grant never deletes a newer grant', () => {
  /** While a close sits between its purges, the old state goes and a new grant opens. */
  function newGrantDuringClose(deps) {
    deps.betweenPurges = vi.fn(async () => {
      fs.rmSync(stateFile(deps));
      deps.advance(1000);
      await grant(request(), deps);
    });
  }

  it('revoke leaves a grant opened while it ran, and its clock', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    const first = JSON.parse(fs.readFileSync(stateFile(deps), 'utf8'));
    newGrantDuringClose(deps);
    await revoke({ tenant: 'tenant-zero', reason: 'done' }, deps);
    const [open] = status(deps);
    expect(open).toBeDefined();
    expect(open.grantId).not.toBe(first.grantId);
    expect(open.deadline).toBeDefined();
  });

  it('expire leaves a grant opened while it closed the expired one', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    deps.advance(GRANT_WINDOW_SECONDS * 1000);
    newGrantDuringClose(deps);
    await expire(deps);
    expect(status(deps)).toHaveLength(1);
    expect(fs.existsSync(stateFile(deps))).toBe(true);
  });

  it('still removes the grant it read when nothing replaced it', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    await revoke({ tenant: 'tenant-zero', reason: 'done' }, deps);
    expect(fs.existsSync(stateFile(deps))).toBe(false);
    expect(fs.readdirSync(deps.stateDir)).toEqual([]);
  });

  it('does not delete state that appeared after a revoke that saw none', async () => {
    const deps = fakeDeps();
    deps.betweenPurges = vi.fn(async () => {
      await grant(request(), deps);
    });
    await revoke({ tenant: 'tenant-zero', reason: 'done' }, deps);
    expect(status(deps)).toHaveLength(1);
  });

  it('removeStateIfSame removes only the named grant and restores another', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    const seen = stateFingerprint(deps, 'tenant-zero');
    expect(removeStateIfSame(deps, 'tenant-zero', 'x:other')).toBe(false);
    expect(stateFingerprint(deps, 'tenant-zero')).toBe(seen);
    expect(removeStateIfSame(deps, 'tenant-zero', seen)).toBe(true);
    expect(fs.existsSync(stateFile(deps))).toBe(false);
    expect(removeStateIfSame(deps, 'tenant-zero', null)).toBe(false);
  });
});

describe('state file hardening', () => {
  it('writes the temporary file exclusively, never through a planted symlink', async () => {
    const deps = fakeDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    const victim = path.join(dir, 'victim');
    fs.writeFileSync(victim, 'keep');
    const real = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).endsWith('.tmp')) fs.symlinkSync(victim, file);
      return real(file, data, options);
    });
    try {
      await expect(grant(request(), deps)).rejects.toThrow(/EEXIST/);
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('expire closes a state file that is a dangling symlink instead of skipping it', async () => {
    const deps = fakeDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    fs.symlinkSync(path.join(dir, 'nowhere'), stateFile(deps));
    const { closed } = await expire(deps);
    expect(closed).toMatchObject([{ tenant: 'tenant-zero', stateFound: false }]);
    expect(closed[0].stateUnreadable).toMatch(/ENOENT/);
    expect(() => fs.lstatSync(stateFile(deps))).toThrow();
  });
});
