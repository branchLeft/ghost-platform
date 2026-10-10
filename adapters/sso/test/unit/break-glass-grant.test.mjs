import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIM_GRACE_MS,
  defaultDeps,
  DOCKER_TIMEOUT_MS,
  EXPIRE_TIMER_UNIT,
  exitOnTermination,
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
  TIMER_STATE_ENV,
  timerReportedActive,
} from '../../scripts/break-glass-grant.mjs';
import { EngineTimeoutError } from '../../scripts/docker-engine.mjs';
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
  const engine = { exec: vi.fn() };

  it('provisions through the Engine client when the account is missing', async () => {
    const provision = vi.fn(async () => ({ created: true }));
    await expect(
      recreateIfDeleted({ container: 'c', identity: 's@x.example' }, engine, provision)
    ).resolves.toEqual({ created: true });
    expect(provision).toHaveBeenCalledWith({ container: 'c', email: 's@x.example' }, engine);
  });

  it('treats an account already present and active as present', async () => {
    const provision = async () => {
      throw new ActiveExistingRowError('active');
    };
    await expect(
      recreateIfDeleted({ container: 'c', identity: 's@x.example' }, engine, provision)
    ).resolves.toEqual({ created: false });
  });

  it('passes any other failure through', async () => {
    const provision = async () => {
      throw new Error('boom');
    };
    await expect(
      recreateIfDeleted({ container: 'c', identity: 's@x.example' }, engine, provision)
    ).rejects.toThrow('boom');
  });
});

/** A fake Engine client: what the tool asks of Docker, with canned answers. */
function fakeEngine({
  listed = [],
  exec = async () => ({ code: 0, stdout: '', stderr: '' }),
} = {}) {
  return { listContainers: vi.fn(async () => listed), exec: vi.fn(exec) };
}
const tzLabels = (service) => ({
  'com.docker.compose.project': 'tz',
  'com.docker.compose.service': service,
});

describe('findTenantContainer', () => {
  it('picks a running Ghost colour by Compose labels, ignoring other services', async () => {
    const engine = fakeEngine({
      listed: [
        { name: 'tz-ghost-b-1', labels: tzLabels('ghost-b') },
        { name: 'tz-sidecar-1', labels: tzLabels('drain') },
        { name: 'tz-ghost-a-1', labels: tzLabels('ghost-a') },
      ],
    });
    await expect(findTenantContainer('tz', engine)).resolves.toBe('tz-ghost-a-1');
    expect(engine.listContainers).toHaveBeenCalledWith({
      labels: { 'com.docker.compose.project': 'tz' },
    });
  });

  it('refuses a container whose label is not this tenant, even if the Engine returned it', async () => {
    const engine = fakeEngine({
      listed: [
        {
          name: 'other-ghost-a-1',
          labels: { ...tzLabels('ghost-a'), 'com.docker.compose.project': 'other' },
        },
      ],
    });
    await expect(findTenantContainer('tz', engine)).rejects.toThrow(/no running Ghost container/);
  });

  it('refuses when no Ghost container is running', async () => {
    const engine = fakeEngine({ listed: [{ name: 'tz-sidecar-1', labels: tzLabels('drain') }] });
    await expect(findTenantContainer('tz', engine)).rejects.toThrow(/no running Ghost container/);
  });
});

describe('runInContainer', () => {
  it('passes only the action and an expected identity as env, and the script as the command', async () => {
    const engine = fakeEngine({
      exec: async () => ({
        code: 0,
        stdout: `Ghost noise\nBL_BREAK_GLASS {"identity":"${SUPPORT}","id":"u1"}\n`,
        stderr: '',
      }),
    });
    await expect(
      runInContainer({ container: 'c', action: 'activate', expect: SUPPORT }, engine)
    ).resolves.toEqual({ identity: SUPPORT, id: 'u1' });
    const request = engine.exec.mock.calls[0][0];
    expect(request.container).toBe('c');
    expect(request.env).toEqual(['BL_ACTION=activate', `BL_EXPECT_IDENTITY=${SUPPORT}`]);
    expect(request.cmd.slice(0, 2)).toEqual(['node', '-e']);
    expect(request.cmd[2]).not.toContain(SUPPORT);
  });

  it('sends no expected identity when none is given', async () => {
    const engine = fakeEngine({
      exec: async () => ({ code: 0, stdout: 'BL_BREAK_GLASS {}\n', stderr: '' }),
    });
    await runInContainer({ container: 'c', action: 'revoke' }, engine);
    expect(engine.exec.mock.calls[0][0].env).toEqual(['BL_ACTION=revoke']);
  });

  it('reads the identity from the tenant config inside the container, never from env', async () => {
    const { INNER_SCRIPT } = await import('../../scripts/break-glass-grant.mjs');
    expect(INNER_SCRIPT).toContain("config.get('adapters:sso:BreakGlassSSO:supportIdentity')");
    expect(INNER_SCRIPT).not.toContain('BL_IDENTITY');
  });

  it('turns an inner refusal into GrantRefusedError', async () => {
    const engine = fakeEngine({
      exec: async () => ({
        code: 1,
        stdout: '',
        stderr: 'BL_BREAK_GLASS_REFUSED the account holds the Owner role; it is never suspended\n',
      }),
    });
    await expect(runInContainer({ container: 'c', action: 'revoke' }, engine)).rejects.toThrow(
      GrantRefusedError
    );
  });

  it('reports any other failure with its exit code and stderr', async () => {
    const engine = fakeEngine({
      exec: async () => ({ code: 126, stdout: '', stderr: 'Error: No such container: c' }),
    });
    await expect(runInContainer({ container: 'c', action: 'revoke' }, engine)).rejects.toThrow(
      /exit 126.*No such container/
    );
  });

  it('refuses output with no result line', async () => {
    const engine = fakeEngine({ exec: async () => ({ code: 0, stdout: 'nothing', stderr: '' }) });
    await expect(runInContainer({ container: 'c', action: 'check' }, engine)).rejects.toThrow(
      /printed no result/
    );
  });

  it('does not wait on a hung Engine: the client bound is what ends the call', async () => {
    const engine = fakeEngine({
      exec: async () => {
        throw new EngineTimeoutError('POST /containers/c/exec', DOCKER_TIMEOUT_MS);
      },
    });
    await expect(runInContainer({ container: 'c', action: 'check' }, engine)).rejects.toThrow(
      /timed out after 60000 ms/
    );
  });
});

describe('the expire timer state the wrapper passes in', () => {
  it('is active only when the wrapper said so', () => {
    expect(TIMER_STATE_ENV).toBe('BL_EXPIRE_TIMER_STATE');
    expect(timerReportedActive({ BL_EXPIRE_TIMER_STATE: 'active' })).toBe(true);
    expect(timerReportedActive({ BL_EXPIRE_TIMER_STATE: 'inactive' })).toBe(false);
    expect(timerReportedActive({ BL_EXPIRE_TIMER_STATE: 'failed' })).toBe(false);
    expect(timerReportedActive({})).toBe(false);
  });

  it('refuses a grant, writing nothing, when the container was started with no timer state', async () => {
    const deps = fakeDeps({ timerActive: defaultDeps({ env: {} }).timerActive });
    await expect(grant(request(), deps)).rejects.toThrow(/is not active, so nothing would close/);
    expect(deps.run).not.toHaveBeenCalled();
    expect(fs.existsSync(deps.stateDir)).toBe(false);
    expect(fs.existsSync(deps.recordLog)).toBe(false);
  });

  it('refuses a grant when the wrapper reported the timer inactive', async () => {
    const env = { BL_EXPIRE_TIMER_STATE: 'inactive' };
    const deps = fakeDeps({ timerActive: defaultDeps({ env }).timerActive });
    await expect(grant(request(), deps)).rejects.toThrow(EXPIRE_TIMER_UNIT);
    expect(fs.existsSync(deps.stateDir)).toBe(false);
  });

  it('opens a grant when the wrapper reported the timer active', async () => {
    const env = { BL_EXPIRE_TIMER_STATE: 'active' };
    const deps = fakeDeps({ timerActive: defaultDeps({ env }).timerActive });
    await expect(grant(request(), deps)).resolves.toMatchObject({ lane: 'incident' });
  });
});

describe('exitOnTermination', () => {
  it('ends the run on SIGTERM and SIGINT, which PID 1 would otherwise ignore', () => {
    const handlers = {};
    const proc = { on: (signal, fn) => (handlers[signal] = fn), exit: vi.fn() };
    exitOnTermination(proc);
    handlers.SIGTERM();
    handlers.SIGINT();
    expect(proc.exit.mock.calls).toEqual([[143], [130]]);
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

  it('keeps a grant opened after the second purge, the timing the issue describes', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    const first = JSON.parse(fs.readFileSync(stateFile(deps), 'utf8'));
    const base = deps.run;
    let purges = 0;
    deps.run = vi.fn(async (call) => {
      const out = await base(call);
      if (call.action === 'revoke' && ++purges === 2) {
        fs.rmSync(stateFile(deps));
        deps.run = base;
        deps.advance(1000);
        await grant(request(), deps);
      }
      return out;
    });
    await revoke({ tenant: 'tenant-zero', reason: 'done' }, deps);
    const [open] = status(deps);
    expect(open.grantId).toBeDefined();
    expect(open.grantId).not.toBe(first.grantId);
  });
});

describe('a newer grant that cannot be linked back is never dropped', () => {
  const linkFails = (code) =>
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error(`link failed ${code}`), { code });
    });
  const claims = (deps) => fs.readdirSync(deps.stateDir).filter((n) => n.endsWith('.claim'));
  const wallClockDeps = () => fakeDeps({ now: () => Date.now() });
  const iso4h = () => new Date(Date.now() + GRANT_WINDOW_SECONDS * 1000).toISOString();

  afterEach(() => vi.restoreAllMocks());

  it('refuses and keeps the newer grant in a claim file', async () => {
    const deps = wallClockDeps();
    await grant(request(), deps);
    const newer = fs.readFileSync(stateFile(deps), 'utf8');
    linkFails('EPERM');
    expect(() => removeStateIfSame(deps, 'tenant-zero', 'x:an older grant')).toThrow(/held in/);
    vi.restoreAllMocks();
    expect(claims(deps)).toHaveLength(1);
    expect(fs.readFileSync(path.join(deps.stateDir, claims(deps)[0]), 'utf8')).toBe(newer);
  });

  it('revoke surfaces it, after the closing record, and keeps the newer grant', async () => {
    const deps = wallClockDeps();
    await grant(request(), deps);
    deps.betweenPurges = vi.fn(async () => {
      fs.rmSync(stateFile(deps));
      await grant(request(), deps);
      linkFails('EPERM');
    });
    await expect(revoke({ tenant: 'tenant-zero', reason: 'done' }, deps)).rejects.toThrow(
      /held in/
    );
    vi.restoreAllMocks();
    expect(records().filter((r) => r.event === 'closed')).toHaveLength(1);
    expect(claims(deps)).toHaveLength(1);
    expect(status(deps)).toEqual([expect.objectContaining({ tenant: 'tenant-zero' })]);
  });

  it('expire puts a held grant back, so its clock runs again', async () => {
    const deps = wallClockDeps();
    await grant(request(), deps);
    const newer = fs.readFileSync(stateFile(deps), 'utf8');
    linkFails('EPERM');
    expect(() => removeStateIfSame(deps, 'tenant-zero', 'x:an older grant')).toThrow();
    vi.restoreAllMocks();
    const later = fakeDeps({ now: () => Date.now() + CLAIM_GRACE_MS + 1000 });
    const { closed, failed } = await expire(later);
    expect(failed).toEqual([]);
    expect(closed).toEqual([]);
    expect(fs.existsSync(stateFile(deps))).toBe(true);
    expect(fs.readFileSync(stateFile(deps), 'utf8')).toBe(newer);
    expect(claims(deps)).toEqual([]);
  });

  it('expire leaves a claim younger than the grace period alone', async () => {
    const deps = wallClockDeps();
    await grant(request(), deps);
    linkFails('EPERM');
    expect(() => removeStateIfSame(deps, 'tenant-zero', 'x:an older grant')).toThrow();
    vi.restoreAllMocks();
    await expire(deps);
    expect(claims(deps)).toHaveLength(1);
    expect(fs.existsSync(stateFile(deps))).toBe(false);
  });

  it('status lists a held grant instead of hiding it', async () => {
    const deps = wallClockDeps();
    await grant(request(), deps);
    linkFails('EPERM');
    expect(() => removeStateIfSame(deps, 'tenant-zero', 'x:an older grant')).toThrow();
    vi.restoreAllMocks();
    const [held] = status(deps);
    expect(held).toMatchObject({ tenant: 'tenant-zero', held: claims(deps)[0] });
    expect(held.deadline).toBeDefined();
  });

  it('a different grant already in place is left alone and the claim is held', async () => {
    const deps = wallClockDeps();
    await grant(request(), deps);
    const real = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      fs.writeFileSync(to, `${JSON.stringify({ grantId: 'third', deadline: iso4h() })}\n`);
      return real(from, to);
    });
    expect(() => removeStateIfSame(deps, 'tenant-zero', 'x:an older grant')).toThrow(/held in/);
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(stateFile(deps), 'utf8')).grantId).toBe('third');
    expect(claims(deps)).toHaveLength(1);
  });

  /** A grant whose link back failed: its state is in a claim file and the state name is empty. */
  async function holdNewerGrant(deps) {
    await grant(request(), deps);
    const newer = fs.readFileSync(stateFile(deps), 'utf8');
    const spy = linkFails('EPERM');
    try {
      expect(() => removeStateIfSame(deps, 'tenant-zero', 'x:an older grant')).toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(claims(deps)).toHaveLength(1);
    return newer;
  }
  const afterGrace = () => fakeDeps({ now: () => Date.now() + CLAIM_GRACE_MS + 1000 });
  const afterDeadline = () =>
    fakeDeps({ now: () => Date.now() + GRANT_WINDOW_SECONDS * 1000 + CLAIM_GRACE_MS });
  const closedRecords = () => records().filter((r) => r.event === 'closed');

  it('expire closes a held grant at its deadline while the link back keeps failing', async () => {
    const deps = wallClockDeps();
    const newer = await holdNewerGrant(deps);
    const due = afterDeadline();
    linkFails('EIO');
    const { closed } = await expire(due);
    vi.restoreAllMocks();
    expect(closed).toHaveLength(1);
    expect(due.calls).toContain('revoke');
    expect(claims(deps)).toEqual([]);
    expect(closedRecords()).toMatchObject([
      { grantId: JSON.parse(newer).grantId, cause: 'timer', heldClaims: 1 },
    ]);
  });

  it('expire does not close a held grant before its deadline', async () => {
    const deps = wallClockDeps();
    await holdNewerGrant(deps);
    const later = afterGrace();
    linkFails('EIO');
    const { closed, failed } = await expire(later);
    vi.restoreAllMocks();
    expect(closed).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(later.calls).not.toContain('revoke');
    expect(claims(deps)).toHaveLength(1);
  });

  it('expire closes a held claim it cannot read once the grace period has passed', async () => {
    const deps = wallClockDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    const claim = path.join(deps.stateDir, '.tenant-zero.1.0123456789ab.claim');
    fs.writeFileSync(claim, 'not json');
    const later = afterGrace();
    linkFails('EIO');
    const { closed } = await expire(later);
    vi.restoreAllMocks();
    expect(closed).toHaveLength(1);
    expect(fs.existsSync(claim)).toBe(false);
  });

  it('grant refuses while a claim is held for the tenant, and writes nothing', async () => {
    const deps = wallClockDeps();
    await holdNewerGrant(deps);
    const before = deps.calls.length;
    await expect(grant(request('consented'), deps)).rejects.toThrow(/held in/);
    expect(deps.calls.slice(before)).toEqual([]);
    expect(fs.existsSync(stateFile(deps))).toBe(false);
  });

  it('a claim left by a killed close survives a consented grant whose check fails', async () => {
    const deps = wallClockDeps();
    fs.mkdirSync(deps.stateDir, { recursive: true });
    const killed = `${JSON.stringify({ grantId: 'killed', tenant: 'tenant-zero', deadline: iso4h() })}\n`;
    fs.writeFileSync(path.join(deps.stateDir, '.tenant-zero.1.0123456789ab.claim'), killed);
    const later = afterGrace();
    deps.run = vi.fn(async ({ action }) => {
      if (action === 'identity') return { identity: SUPPORT };
      await expire(later);
      throw new Error('exec check failed');
    });
    await expect(grant(request('consented'), deps)).rejects.toThrow();
    await expire(later);
    expect(fs.existsSync(stateFile(deps))).toBe(true);
    expect(JSON.parse(fs.readFileSync(stateFile(deps), 'utf8')).grantId).toBe('killed');
  });

  it('reclaim keeps a held grant when a different grant holds the state, then closes it', async () => {
    const deps = wallClockDeps();
    const held = await holdNewerGrant(deps);
    const third = `${JSON.stringify({ grantId: 'third', deadline: iso4h() })}\n`;
    fs.writeFileSync(stateFile(deps), third);
    const { closed, failed } = await expire(afterGrace());
    expect(closed).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(claims(deps)).toHaveLength(1);
    expect(fs.readFileSync(stateFile(deps), 'utf8')).toBe(third);
    expect(fs.readFileSync(path.join(deps.stateDir, claims(deps)[0]), 'utf8')).toBe(held);
    await expire(afterDeadline());
    expect(claims(deps)).toEqual([]);
    expect(fs.existsSync(stateFile(deps))).toBe(false);
  });

  it('reclaim drops a claim that is the same file as the state, without calling it superseded', async () => {
    const deps = wallClockDeps();
    await grant(request(), deps);
    fs.linkSync(stateFile(deps), path.join(deps.stateDir, '.tenant-zero.1.0123456789ab.claim'));
    const later = afterGrace();
    const { closed, failed } = await expire(later);
    expect(closed).toEqual([]);
    expect(failed).toEqual([]);
    expect(claims(deps)).toEqual([]);
    expect(fs.existsSync(stateFile(deps))).toBe(true);
    expect(later.log).not.toHaveBeenCalledWith(expect.stringMatching(/superseded/));
  });

  it('an explicit revoke closes a held grant, so its state does not come back', async () => {
    const deps = wallClockDeps();
    await holdNewerGrant(deps);
    await revoke({ tenant: 'tenant-zero', reason: 'done' }, deps);
    expect(claims(deps)).toEqual([]);
    expect(closedRecords()).toMatchObject([{ heldClaims: 1, stateFound: false }]);
    await expire(afterGrace());
    expect(fs.existsSync(stateFile(deps))).toBe(false);
  });

  it('a failed consented grant reports its own failure, and the newer grant stays held', async () => {
    const deps = wallClockDeps();
    deps.run = vi.fn(({ action }) => {
      if (action === 'identity') return { identity: SUPPORT };
      fs.rmSync(stateFile(deps));
      fs.writeFileSync(stateFile(deps), `${JSON.stringify({ grantId: 'n', deadline: iso4h() })}\n`);
      throw new Error('the check failed');
    });
    const real = fs.linkSync;
    let calls = 0;
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (++calls > 1) throw Object.assign(new Error('link failed'), { code: 'EPERM' });
      return real(from, to);
    });
    await expect(grant(request('consented'), deps)).rejects.toThrow(/the check failed/);
    vi.restoreAllMocks();
    expect(claims(deps)).toHaveLength(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/held in/));
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
