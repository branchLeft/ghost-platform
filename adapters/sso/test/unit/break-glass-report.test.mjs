import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRANT_WINDOW_SECONDS,
  GrantRefusedError,
  INNER_SCRIPT,
  main,
  parseGrantArgs,
  report,
} from '../../scripts/break-glass-grant.mjs';

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const SUPPORT = 'support@platform.example';
const iso = (ms) => new Date(ms).toISOString();
let dir;

/** The clock file `grant` writes, with the fields a report must never repeat. */
const GRANT_FILE = {
  grantId: '6f1f0b7e-0c43-4c6f-9d77-2f6c5b0a1111',
  tenant: 'tenant-zero',
  identity: SUPPORT,
  lane: 'incident',
  reason: 'REASON_TEXT_NEVER_REPORTED',
  reference: 'REFERENCE_TEXT_NEVER_REPORTED',
  grantedAt: iso(T0 - 3_600_000),
  deadline: iso(T0 - 3_600_000 + GRANT_WINDOW_SECONDS * 1000),
};

/** Dependencies whose container answers `account` to the report action and records every call. */
function fakeDeps(account, overrides = {}) {
  const calls = [];
  return {
    stateDir: path.join(dir, 'grants'),
    recordLog: path.join(dir, 'grants.jsonl'),
    now: () => T0,
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
    timerActive: () => false,
    findContainer: vi.fn((tenant) => `${tenant}-ghost-a-1`),
    run: vi.fn(({ action }) => {
      calls.push(action);
      return account;
    }),
    recreate: vi.fn(),
    betweenPurges: vi.fn(),
    calls,
    ...overrides,
  };
}

const ACTIVE = { present: true, status: 'active', roles: ['Administrator'] };
const writeGrantFile = (deps, state = GRANT_FILE) => {
  fs.mkdirSync(deps.stateDir, { recursive: true });
  fs.writeFileSync(path.join(deps.stateDir, 'tenant-zero.json'), `${JSON.stringify(state)}\n`);
};

/** Every file under the state directory and the record log, by name and bytes. */
const snapshot = (deps) => {
  const files = {};
  for (const directory of [deps.stateDir]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).sort()) {
      files[name] = fs.readFileSync(path.join(directory, name), 'utf8');
    }
  }
  files['<record log exists>'] = String(fs.existsSync(deps.recordLog));
  return files;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-report-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('parseGrantArgs: report', () => {
  it('takes the tenant and nothing else', () => {
    expect(parseGrantArgs(['report', '--tenant', 'tenant-zero'])).toEqual({
      command: 'report',
      tenant: 'tenant-zero',
    });
    expect(() => parseGrantArgs(['report'])).toThrow(/report needs --tenant/);
    for (const extra of ['--reason', '--reference', '--identity', '--lane']) {
      expect(() => parseGrantArgs(['report', '--tenant', 'tenant-zero', extra, 'x'])).toThrow(
        /report does not take/
      );
    }
  });
});

describe('report', () => {
  it('an active account with a clock file is open, with the lane and the clock', async () => {
    const deps = fakeDeps(ACTIVE);
    writeGrantFile(deps);
    expect(await report({ tenant: 'tenant-zero' }, deps)).toEqual({
      tenant: 'tenant-zero',
      state: 'open',
      lane: 'incident',
      grantedAt: GRANT_FILE.grantedAt,
      deadline: GRANT_FILE.deadline,
      observedAt: iso(T0),
    });
  });

  it('prints no reason, no reference, no identity and no grant id', async () => {
    const deps = fakeDeps(ACTIVE);
    writeGrantFile(deps);
    const text = JSON.stringify(await report({ tenant: 'tenant-zero' }, deps));
    for (const secret of [
      GRANT_FILE.reason,
      GRANT_FILE.reference,
      GRANT_FILE.grantId,
      SUPPORT,
      'reason',
      'reference',
      'identity',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('an inactive account is closed, and a clock file left behind is not reported', async () => {
    const deps = fakeDeps({ present: true, status: 'inactive', roles: ['Administrator'] });
    writeGrantFile(deps);
    expect(await report({ tenant: 'tenant-zero' }, deps)).toEqual({
      tenant: 'tenant-zero',
      state: 'closed',
      lane: null,
      grantedAt: null,
      deadline: null,
      observedAt: iso(T0),
    });
  });

  it('a locked account is closed, and one the tenant deleted is closed', async () => {
    for (const account of [
      { present: true, status: 'locked', roles: ['Administrator'] },
      { present: false, status: null, roles: [] },
    ]) {
      expect((await report({ tenant: 'tenant-zero' }, fakeDeps(account))).state).toBe('closed');
    }
  });

  it.each(['active', 'warn-1', 'warn-2', 'warn-3', 'warn-4'])('%s is open', async (status) => {
    const account = { present: true, status, roles: ['Administrator'] };
    expect((await report({ tenant: 'tenant-zero' }, fakeDeps(account))).state).toBe('open');
  });

  it('a status it does not know, or an account that is not only an Administrator, is unknown', async () => {
    for (const account of [
      { present: true, status: 'something-new', roles: ['Administrator'] },
      { present: true, status: 'active', roles: ['Administrator', 'Editor'] },
      { present: true, status: 'active', roles: ['Editor'] },
      { present: true, status: 'active', roles: [] },
      { present: true, status: 'inactive', roles: ['Owner'] },
    ]) {
      expect((await report({ tenant: 'tenant-zero' }, fakeDeps(account))).state).toBe('unknown');
    }
  });

  it('an open account whose clock cannot be read is still open, with no clock', async () => {
    const deps = fakeDeps(ACTIVE);
    fs.mkdirSync(deps.stateDir, { recursive: true });
    fs.writeFileSync(path.join(deps.stateDir, 'tenant-zero.json'), 'not json');
    expect(await report({ tenant: 'tenant-zero' }, deps)).toMatchObject({
      state: 'open',
      lane: null,
      grantedAt: null,
      deadline: null,
    });
  });

  it('an open account with no clock file is open, with no clock', async () => {
    expect(await report({ tenant: 'tenant-zero' }, fakeDeps(ACTIVE))).toMatchObject({
      state: 'open',
      lane: null,
      deadline: null,
    });
  });

  it('does not need the expire timer, which only a grant needs', async () => {
    const deps = fakeDeps(ACTIVE, { timerActive: () => false });
    expect((await report({ tenant: 'tenant-zero' }, deps)).state).toBe('open');
  });

  it('refuses when the tenant has no running container, rather than guessing', async () => {
    const deps = fakeDeps(ACTIVE, {
      findContainer: () => {
        throw new GrantRefusedError('no running Ghost container for tenant tenant-zero');
      },
    });
    await expect(report({ tenant: 'tenant-zero' }, deps)).rejects.toThrow(/no running Ghost/);
  });
});

describe('report is read-only (a write path turns these red)', () => {
  it('asks the container for the report action once, and for nothing else', async () => {
    const deps = fakeDeps(ACTIVE);
    writeGrantFile(deps);
    await report({ tenant: 'tenant-zero' }, deps);
    expect(deps.calls).toEqual(['report']);
    expect(deps.recreate).not.toHaveBeenCalled();
    expect(deps.betweenPurges).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('changes no file: the clock, an unreadable clock and the record log are as they were', async () => {
    const deps = fakeDeps(ACTIVE);
    writeGrantFile(deps);
    fs.writeFileSync(path.join(deps.stateDir, 'other-tenant.json'), 'unreadable');
    fs.writeFileSync(path.join(deps.stateDir, '.other.1.2.claim'), '{}');
    const before = snapshot(deps);
    await report({ tenant: 'tenant-zero' }, deps);
    await report({ tenant: 'other-tenant' }, deps);
    expect(snapshot(deps)).toEqual(before);
  });

  it('writes nothing to an empty host either', async () => {
    const deps = fakeDeps(ACTIVE);
    await report({ tenant: 'tenant-zero' }, deps);
    expect(fs.existsSync(deps.stateDir)).toBe(false);
    expect(fs.existsSync(deps.recordLog)).toBe(false);
  });

  it('main prints one line of JSON and exits 0', async () => {
    const deps = fakeDeps(ACTIVE);
    const out = {
      text: '',
      write(s) {
        this.text += s;
      },
    };
    expect(await main(['report', '--tenant', 'tenant-zero'], deps, out)).toBe(0);
    expect(out.text.endsWith('\n')).toBe(true);
    expect(JSON.parse(out.text)).toMatchObject({ tenant: 'tenant-zero', state: 'open' });
    expect(out.text.trim().split('\n')).toHaveLength(1);
  });
});

/**
 * Runs the script that executes inside the tenant's Ghost container, against a
 * stand-in for Ghost's knex that refuses every write and every row lock, and
 * returns what it printed and which refused calls it made.
 */
async function runInner(action, { user, roles }) {
  const refused = [];
  const queried = [];
  const refuse = (name) => () => {
    refused.push(name);
    throw new Error(`write path: ${name}`);
  };
  const builder = (table) => {
    const query = { table };
    const chain = () => query;
    Object.assign(query, {
      where: chain,
      join: chain,
      modify: (apply) => {
        apply(query);
        return query;
      },
      update: refuse('update'),
      del: refuse('del'),
      insert: refuse('insert'),
      forUpdate: refuse('forUpdate'),
      first: async () => {
        queried.push(`${table}.first`);
        return user;
      },
      select: async () => {
        queried.push(`${table}.select`);
        return roles.map((name) => ({ name }));
      },
    });
    return query;
  };
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const knex = Object.assign((table) => builder(table), {
    client: { config: { client: 'mysql2' } },
    transaction: async (work) => work(knex),
    destroy: async () => finished(),
  });
  const printed = [];
  const fakeRequire = (id) => {
    if (id.endsWith('shared/config')) return { get: () => SUPPORT };
    if (id.endsWith('db/connection.js')) return knex;
    throw new Error(`unexpected require ${id}`);
  };
  const proc = { chdir() {}, env: { BL_ACTION: action }, exitCode: undefined };
  new Function('require', 'process', 'console', INNER_SCRIPT)(fakeRequire, proc, {
    log: (line) => printed.push(line),
    error: (line) => printed.push(`stderr: ${line}`),
  });
  await done;
  return { printed, refused, queried, exitCode: proc.exitCode };
}

describe('the script inside the container: the report action', () => {
  const marker = 'BL_BREAK_GLASS ';

  it('reads the account status and roles and prints them, without the address', async () => {
    const { printed, refused, queried } = await runInner('report', {
      user: { id: 'u1', status: 'active' },
      roles: ['Administrator'],
    });
    expect(refused).toEqual([]);
    expect(queried).toEqual(['users.first', 'roles.select']);
    expect(printed).toHaveLength(1);
    expect(printed[0].startsWith(marker)).toBe(true);
    expect(JSON.parse(printed[0].slice(marker.length))).toEqual({
      present: true,
      status: 'active',
      roles: ['Administrator'],
    });
    expect(printed[0]).not.toContain(SUPPORT);
  });

  it('reports a missing account as absent', async () => {
    const { printed, refused } = await runInner('report', { user: undefined, roles: [] });
    expect(refused).toEqual([]);
    expect(JSON.parse(printed[0].slice(marker.length))).toEqual({
      present: false,
      status: null,
      roles: [],
    });
  });

  it('makes no write and takes no row lock on the way', async () => {
    const result = await runInner('report', {
      user: { id: 'u1', status: 'inactive' },
      roles: ['Administrator'],
    });
    expect(result.refused).toEqual([]);
    expect(result.exitCode).toBeUndefined();
  });

  it('control case: the harness does see a write when the revoke action runs', async () => {
    const result = await runInner('revoke', {
      user: { id: 'u1', status: 'active' },
      roles: ['Administrator'],
    });
    expect(result.refused.length).toBeGreaterThan(0);
  });
});
