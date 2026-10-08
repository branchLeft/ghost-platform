import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPIRE_TIMER_UNIT,
  expire,
  findTenantContainer,
  grant,
  GRANT_WINDOW_SECONDS,
  GrantRefusedError,
  main,
  parseGrantArgs,
  recreateIfDeleted,
  revoke,
  runInContainer,
  SECOND_PURGE_DELAY_MS,
  status,
} from '../../scripts/break-glass-grant.mjs';
import { ActiveExistingRowError } from '../../scripts/provision-support-account.mjs';

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
let dir;

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
    timerActive: () => true,
    findContainer: (tenant) => `${tenant}-ghost-a-1`,
    run: vi.fn(({ action }) => {
      calls.push(action);
      if (action === 'revoke')
        return { found: true, id: 'u1', previousStatus: 'active', sessionsPurged: 1 };
      return { id: 'u1', previousStatus: action === 'check' ? 'active' : 'inactive' };
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

const request = (lane = 'incident') => ({
  lane,
  tenant: 'tenant-zero',
  identity: 'support@platform.example',
  reason: 'readers see errors',
  reference: 'workspace#0',
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-grant-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('parseGrantArgs', () => {
  const full = [
    '--lane',
    'incident',
    '--tenant',
    't',
    '--identity',
    's@x.example',
    '--reason',
    'r',
    '--reference',
    'ref',
  ];

  it('parses a grant', () => {
    expect(parseGrantArgs(['grant', ...full])).toMatchObject({
      command: 'grant',
      lane: 'incident',
      tenant: 't',
    });
  });

  it('refuses a lane other than consented or incident', () => {
    expect(() =>
      parseGrantArgs(['grant', ...full.slice(0, 1), 'standing', ...full.slice(2)])
    ).toThrow(/--lane/);
  });

  it('refuses a grant missing its reference', () => {
    expect(() => parseGrantArgs(['grant', ...full.slice(0, 8)])).toThrow(/needs --reference/);
  });

  it('refuses a flag the command does not take, such as a window length', () => {
    expect(() =>
      parseGrantArgs(['revoke', '--tenant', 't', '--reason', 'r', '--lane', 'incident'])
    ).toThrow(/does not take --lane/);
    expect(() => parseGrantArgs(['grant', ...full, '--hours', '8'])).toThrow(/unrecognised/);
  });

  it('refuses a tenant that is not a slug, and a bad identity', () => {
    expect(() => parseGrantArgs(['revoke', '--tenant', '../etc', '--reason', 'r'])).toThrow(
      /--tenant/
    );
    expect(() =>
      parseGrantArgs(['grant', ...full.slice(0, 5), 'nobody', ...full.slice(6)])
    ).toThrow(/--identity/);
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

describe('grant', () => {
  it('refuses to open anything when the expire timer is not active', async () => {
    const deps = fakeDeps({ timerActive: () => false });
    await expect(grant(request(), deps)).rejects.toThrow(EXPIRE_TIMER_UNIT);
    expect(deps.run).not.toHaveBeenCalled();
    expect(fs.existsSync(deps.stateDir)).toBe(false);
  });

  it('incident lane: recreates if deleted, activates, and sets a four-hour deadline', async () => {
    const deps = fakeDeps({ recreate: vi.fn(() => ({ created: true })) });
    const opened = await grant(request(), deps);
    expect(deps.recreate).toHaveBeenCalledWith({
      container: 'tenant-zero-ghost-a-1',
      identity: 'support@platform.example',
    });
    expect(deps.calls).toEqual(['activate']);
    expect(opened).toMatchObject({ recreated: true, previousStatus: 'inactive' });
    expect(Date.parse(opened.deadline) - T0).toBe(GRANT_WINDOW_SECONDS * 1000);
    expect(GRANT_WINDOW_SECONDS).toBe(14400);
    expect(records()).toMatchObject([{ event: 'opened', lane: 'incident', recreated: true }]);
    expect(fs.statSync(path.join(deps.stateDir, 'tenant-zero.json')).mode & 0o777).toBe(0o600);
  });

  it('consented lane: only checks, never writes the account, and starts the same clock', async () => {
    const deps = fakeDeps();
    const opened = await grant(request('consented'), deps);
    expect(deps.recreate).not.toHaveBeenCalled();
    expect(deps.calls).toEqual(['check']);
    expect(Date.parse(opened.deadline) - T0).toBe(GRANT_WINDOW_SECONDS * 1000);
  });

  it('consented lane: a refused check leaves no clock behind, since nothing was opened', async () => {
    const deps = fakeDeps({
      run: () => {
        throw new GrantRefusedError('the tenant has not un-suspended the support account');
      },
    });
    await expect(grant(request('consented'), deps)).rejects.toThrow(/not un-suspended/);
    expect(status(deps)).toEqual([]);
  });

  it('incident lane: a failure keeps the clock, so the timer still closes what may have opened', async () => {
    const deps = fakeDeps({
      run: () => {
        throw new Error('docker exec activate failed');
      },
    });
    await expect(grant(request(), deps)).rejects.toThrow(/activate failed/);
    expect(status(deps)).toHaveLength(1);
  });

  it('writes the clock before it touches the account', async () => {
    const deps = fakeDeps();
    deps.recreate = vi.fn(() => {
      expect(fs.existsSync(path.join(deps.stateDir, 'tenant-zero.json'))).toBe(true);
      return { created: false };
    });
    await grant(request(), deps);
    expect(deps.recreate).toHaveBeenCalled();
  });

  it('refuses a second grant while one is open', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    await expect(grant(request(), deps)).rejects.toThrow(/already open until/);
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
    expect(deps.sleep).toHaveBeenCalledWith(SECOND_PURGE_DELAY_MS);
    expect(SECOND_PURGE_DELAY_MS).toBeGreaterThanOrEqual(2000);
    expect(closing).toMatchObject({
      event: 'closed',
      cause: 'explicit',
      closeReason: 'incident closed',
      sessionsPurged: [1, 1],
    });
    expect(records().map((r) => r.event)).toEqual(['opened', 'closed']);
    expect(status(deps)).toEqual([]);
  });

  it('closes a grant whose account the tenant deleted, and records that', async () => {
    const deps = fakeDeps();
    await grant(request(), deps);
    deps.run = vi.fn(() => ({ found: false, sessionsPurged: 0 }));
    const closing = await revoke({ tenant: 'tenant-zero', reason: 'r' }, deps);
    expect(closing).toMatchObject({ accountFound: false, previousStatus: null });
  });

  it('refuses when no grant is open', async () => {
    await expect(revoke({ tenant: 'tenant-zero', reason: 'r' }, fakeDeps())).rejects.toThrow(
      /no grant is open/
    );
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

  it('does nothing when no grant has ever been opened', async () => {
    expect(await expire(fakeDeps())).toEqual({ closed: [], failed: [] });
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
    const flags = [
      '--tenant',
      'tenant-zero',
      '--identity',
      'support@platform.example',
      '--reason',
      'r',
      '--reference',
      'x',
    ];
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
  it('provisions when the account is missing', () => {
    const provision = vi.fn(() => ({ created: true }));
    expect(recreateIfDeleted({ container: 'c', identity: 's@x.example' }, provision)).toEqual({
      created: true,
    });
    expect(provision).toHaveBeenCalledWith({ container: 'c', email: 's@x.example' });
  });

  it('treats an account the tenant already un-suspended as present', () => {
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
  it('picks a running Ghost colour by Compose labels, ignoring other services', () => {
    const execFile = vi.fn(
      () => 'tz-ghost-b-1\tghost-b\ntz-sidecar-1\tdrain\ntz-ghost-a-1\tghost-a\n'
    );
    expect(findTenantContainer('tz', execFile)).toBe('tz-ghost-a-1');
    expect(execFile.mock.calls[0][1]).toContain('label=com.docker.compose.project=tz');
  });

  it('refuses when no Ghost container is running', () => {
    expect(() => findTenantContainer('tz', () => 'tz-sidecar-1\tdrain\n')).toThrow(
      /no running Ghost container/
    );
  });
});

describe('runInContainer', () => {
  it('passes values as env, never as script text, and parses the marked result', () => {
    const execFile = vi.fn(
      () => 'Ghost noise\nBL_BREAK_GLASS {"id":"u1","previousStatus":"inactive"}\n'
    );
    expect(
      runInContainer({ container: 'c', identity: 's@x.example', action: 'activate' }, execFile)
    ).toEqual({
      id: 'u1',
      previousStatus: 'inactive',
    });
    const argv = execFile.mock.calls[0][1];
    expect(argv.slice(0, 6)).toEqual([
      'exec',
      '-e',
      'BL_IDENTITY=s@x.example',
      '-e',
      'BL_ACTION=activate',
      'c',
    ]);
    expect(argv[argv.length - 1]).not.toContain('s@x.example');
  });

  it('turns an inner refusal into GrantRefusedError', () => {
    const execFile = () => {
      const e = new Error('exit 1');
      e.stderr = 'BL_BREAK_GLASS_REFUSED the account holds the Owner role; it is never suspended\n';
      throw e;
    };
    expect(() =>
      runInContainer({ container: 'c', identity: 'o@x.example', action: 'revoke' }, execFile)
    ).toThrow(GrantRefusedError);
  });

  it('reports any other failure with its stderr', () => {
    const execFile = () => {
      const e = new Error('exit 1');
      e.stderr = 'Error: No such container: c';
      throw e;
    };
    expect(() =>
      runInContainer({ container: 'c', identity: 's@x.example', action: 'revoke' }, execFile)
    ).toThrow(/No such container/);
  });

  it('refuses output with no result line', () => {
    expect(() =>
      runInContainer({ container: 'c', identity: 's@x.example', action: 'check' }, () => 'nothing')
    ).toThrow(/printed no result/);
  });
});
