import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DemoHostnameExistsError,
  HostnameAllocationRefusedError,
  HostnameRetiredError,
  HostnameReusedError,
  UnknownDemoError,
  UnknownHostnameError,
} from '../src/demoLifecycle.js';
import { LABEL_ALPHABET, LABEL_LENGTH, LABEL_PATTERN } from '../src/demoStates.js';
import { OwnerDb } from '../src/owner/index.js';
import { ProvisionerDb } from '../src/provisioner/index.js';
import { createFixture, type Fixture } from './helpers.js';

let fx: Fixture;
let provisioner: ProvisionerDb;

beforeAll(async () => {
  fx = await createFixture();
  provisioner = new ProvisionerDb(fx.provisioner);
}, 60000);

afterAll(async () => {
  await fx.close();
});

async function claimed(demoId = randomUUID(), db = provisioner): Promise<string> {
  await db.beginDemo(demoId);
  await db.transition(demoId, 'CLAIMED');
  return demoId;
}

/** A provisioner whose labels come from `labels`, one per allocation: the seam a test uses to force a collision. */
function labelled(...labels: string[]): { db: ProvisionerDb; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const queue = [...labels];
  const db = new ProvisionerDb(fx.provisioner, (...args: unknown[]) => {
    calls.push(args);
    return queue.shift()!;
  });
  return { db, calls };
}

async function registerRows(): Promise<Record<string, unknown>[]> {
  const result = await fx.admin.query<{ row: Record<string, unknown> }>(
    'SELECT to_jsonb(r) AS row FROM portal.hostname_register r ORDER BY label'
  );
  return result.rows.map((r) => r.row);
}

describe('allocating a hostname', () => {
  it('gives a demo one label of 20 base32 characters, recorded with the database clock', async () => {
    const demoId = await claimed();
    const before = await fx.admin.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const label = await provisioner.allocateHostname(demoId);
    const after = await fx.admin.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    expect(label).toHaveLength(LABEL_LENGTH);
    expect(label).toMatch(new RegExp(LABEL_PATTERN));
    expect(await provisioner.hostname(demoId)).toBe(label);
    const [stored] = (
      await fx.admin.query<{ allocated_at: Date; demo_id: string }>(
        'SELECT allocated_at, demo_id FROM portal.hostname_register WHERE label = $1',
        [label]
      )
    ).rows;
    expect(stored!.demo_id).toBe(demoId);
    expect(stored!.allocated_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]!.now.getTime() - 1
    );
    expect(stored!.allocated_at.getTime()).toBeLessThanOrEqual(after.rows[0]!.now.getTime());
  });

  it('gives two demos two different labels', async () => {
    const first = await provisioner.allocateHostname(await claimed());
    const second = await provisioner.allocateHostname(await claimed());
    expect(first).not.toBe(second);
  });

  it('asks the label source for nothing: no demo id, prospect text or slot reaches it', async () => {
    const demoId = await claimed();
    const { db, calls } = labelled('abcdefghijklmnopqrst');
    const label = await db.allocateHostname(demoId);
    expect(label).toBe('abcdefghijklmnopqrst');
    expect(calls).toEqual([[]]);
    expect(label.replaceAll('-', '')).not.toContain(demoId.slice(0, 8));
  });

  it('refuses a label already in the register, whoever allocated it, and records nothing for the second demo', async () => {
    const holder = await claimed();
    const rival = await claimed();
    const { db } = labelled('zzzzzzzzzzzzzzzzzzzz', 'zzzzzzzzzzzzzzzzzzzz');
    await db.allocateHostname(holder);
    await expect(db.allocateHostname(rival)).rejects.toThrow(HostnameReusedError);
    expect(await provisioner.hostname(rival)).toBeNull();
    expect(await provisioner.hostname(holder)).toBe('zzzzzzzzzzzzzzzzzzzz');
  });

  it('records exactly one of two simultaneous allocations of the same label', async () => {
    const [first, second] = [await claimed(), await claimed()];
    const { db } = labelled('yyyyyyyyyyyyyyyyyyyy', 'yyyyyyyyyyyyyyyyyyyy');
    const results = await Promise.allSettled([
      db.allocateHostname(first),
      db.allocateHostname(second),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(HostnameReusedError);
    const stored = await fx.admin.query(
      "SELECT 1 FROM portal.hostname_register WHERE label = 'yyyyyyyyyyyyyyyyyyyy'"
    );
    expect(stored.rowCount).toBe(1);
  });

  it('refuses the same label at the table for a process that is not this code', async () => {
    const label = await provisioner.allocateHostname(await claimed());
    await expect(
      fx.admin.query('INSERT INTO portal.hostname_register (label, demo_id) VALUES ($1, $2)', [
        label,
        randomUUID(),
      ])
    ).rejects.toMatchObject({ code: '23505', constraint: 'hostname_register_pkey' });
  });

  it('never allocates a label again after its retirement', async () => {
    const holder = await claimed();
    const { db } = labelled('xxxxxxxxxxxxxxxxxxxx', 'xxxxxxxxxxxxxxxxxxxx');
    const label = await db.allocateHostname(holder);
    await db.retireHostname(label);
    await expect(db.allocateHostname(await claimed())).rejects.toThrow(HostnameReusedError);
  });

  it('gives a demo at most one hostname for its whole life', async () => {
    const demoId = await claimed();
    await provisioner.allocateHostname(demoId);
    await expect(provisioner.allocateHostname(demoId)).rejects.toThrow(DemoHostnameExistsError);
    await expect(
      fx.admin.query('INSERT INTO portal.hostname_register (label, demo_id) VALUES ($1, $2)', [
        'wwwwwwwwwwwwwwwwwwww',
        demoId,
      ])
    ).rejects.toMatchObject({ code: '23505', constraint: 'hostname_register_demo_id_unique' });
  });

  it('allocates while the demo is CLAIMED and at no other time', async () => {
    const verified = randomUUID();
    await provisioner.beginDemo(verified);
    await expect(provisioner.allocateHostname(verified)).rejects.toThrow(
      HostnameAllocationRefusedError
    );
    await expect(provisioner.allocateHostname(randomUUID())).rejects.toThrow(UnknownDemoError);
    const live = await claimed();
    await provisioner.transition(live, 'PROVISIONING');
    await expect(provisioner.allocateHostname(live)).rejects.toThrow(
      'a hostname is allocated while a demo is CLAIMED'
    );
  });

  it('keeps the hostname when a demo is rebuilt', async () => {
    const demoId = await claimed();
    const label = await provisioner.allocateHostname(demoId);
    for (const state of ['PROVISIONING', 'LIVE', 'REBUILDING', 'LIVE'] as const) {
      await provisioner.transition(demoId, state);
    }
    expect(await provisioner.hostname(demoId)).toBe(label);
  });

  it('keeps the label with a claim that timed out and was claimed again', async () => {
    const demoId = await claimed();
    const label = await provisioner.allocateHostname(demoId);
    await provisioner.transition(demoId, 'WAITING');
    await provisioner.transition(demoId, 'CLAIMED');
    await expect(provisioner.allocateHostname(demoId)).rejects.toThrow(DemoHostnameExistsError);
    expect(await provisioner.hostname(demoId)).toBe(label);
  });
});

describe('the label shape the table pins', () => {
  const insert = (label: string): Promise<unknown> =>
    fx.admin.query('INSERT INTO portal.hostname_register (label, demo_id) VALUES ($1, $2)', [
      label,
      randomUUID(),
    ]);

  it.each([
    ['upper case', 'ABCDEFGHIJKLMNOPQRST'],
    ['a digit outside base32', 'abcdefghijklmnopqrs1'],
    ['too short', 'abcdefghijklmnopqrs'],
    ['too long', 'abcdefghijklmnopqrstu'],
    ['a hyphen', 'abcdefghijklmnop-rst'],
    ['empty', ''],
  ])('refuses a label that is %s', async (_name, label) => {
    await expect(insert(label)).rejects.toMatchObject({
      code: '23514',
      constraint: 'hostname_register_label_shape',
    });
  });

  it('accepts every letter of the alphabet', async () => {
    await insert(LABEL_ALPHABET.slice(1, LABEL_LENGTH + 1));
    await insert(LABEL_ALPHABET.slice(-LABEL_LENGTH));
    const stored = await fx.admin.query(
      'SELECT 1 FROM portal.hostname_register WHERE label = ANY($1)',
      [[LABEL_ALPHABET.slice(1, LABEL_LENGTH + 1), LABEL_ALPHABET.slice(-LABEL_LENGTH)]]
    );
    expect(stored.rowCount).toBe(2);
  });
});

describe('retiring a hostname', () => {
  it('appends a row keyed on the label and leaves the register row as it was', async () => {
    const demoId = await claimed();
    const label = await provisioner.allocateHostname(demoId);
    const before = await registerRows();
    const marker = await fx.admin.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    await provisioner.retireHostname(label);
    expect(await registerRows()).toEqual(before);
    const [row] = (
      await fx.admin.query<{ label: string; retired_at: Date }>(
        'SELECT label, retired_at FROM portal.hostname_retirement WHERE label = $1',
        [label]
      )
    ).rows;
    expect(row!.label).toBe(label);
    expect(row!.retired_at.getTime()).toBeGreaterThanOrEqual(marker.rows[0]!.now.getTime() - 1);
  });

  it('refuses a label that is not in the register', async () => {
    const error = await provisioner.retireHostname('vvvvvvvvvvvvvvvvvvvv').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownHostnameError);
    const none = await fx.admin.query(
      "SELECT 1 FROM portal.hostname_retirement WHERE label = 'vvvvvvvvvvvvvvvvvvvv'"
    );
    expect(none.rowCount).toBe(0);
  });

  it('refuses a second retirement of the same label', async () => {
    const label = await provisioner.allocateHostname(await claimed());
    await provisioner.retireHostname(label);
    await expect(provisioner.retireHostname(label)).rejects.toThrow(HostnameRetiredError);
    const rows = await fx.admin.query('SELECT 1 FROM portal.hostname_retirement WHERE label = $1', [
      label,
    ]);
    expect(rows.rowCount).toBe(1);
  });
});

describe('what the register holds', () => {
  async function columns(table: string): Promise<string[]> {
    const result = await fx.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    return result.rows.map((row) => row.column_name);
  }

  it('is a label, an opaque demo id and the allocation time, and nothing a prospect typed', async () => {
    expect(await columns('hostname_register')).toEqual(['label', 'demo_id', 'allocated_at']);
  });

  it('keeps a retirement to a label and a time', async () => {
    expect(await columns('hostname_retirement')).toEqual(['label', 'retired_at']);
  });

  it('types the demo id as a uuid and the times as timestamps, so no free text fits beside the label', async () => {
    const result = await fx.admin.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name IN ('hostname_register', 'hostname_retirement')
        ORDER BY table_name, ordinal_position`
    );
    expect(result.rows.map((r) => `${r.table_name}.${r.column_name} ${r.data_type}`)).toEqual([
      'hostname_register.label text',
      'hostname_register.demo_id uuid',
      'hostname_register.allocated_at timestamp with time zone',
      'hostname_retirement.label text',
      'hostname_retirement.retired_at timestamp with time zone',
    ]);
  });
});

describe('the owner console reads', () => {
  it('lists demos with state, term and hostname, a demo’s history, and the register with retirements', async () => {
    const owner = new OwnerDb(fx.owner);
    const demoId = await claimed();
    const label = await provisioner.allocateHostname(demoId);
    await provisioner.transition(demoId, 'PROVISIONING');
    const summary = (await owner.listDemos()).find((demo) => demo.demoId === demoId);
    expect(summary).toMatchObject({ state: 'PROVISIONING', hostname: label });
    expect(summary!.leaseEndsAt).toBeInstanceOf(Date);
    expect((await owner.demoHistory(demoId)).map((event) => event.toState)).toEqual([
      'VERIFIED',
      'CLAIMED',
      'PROVISIONING',
    ]);
    expect(await owner.demoHostname(demoId)).toBe(label);
    await provisioner.retireHostname(label);
    const entry = (await owner.listHostnames()).find((row) => row.label === label);
    expect(entry).toMatchObject({ demoId, retiredAt: expect.any(Date) });
    const open = (await owner.listHostnames()).find((row) => row.label !== label);
    expect(open?.retiredAt ?? null).toBeNull();
  });

  it('shows a demo with no hostname yet', async () => {
    const demoId = randomUUID();
    await provisioner.beginDemo(demoId);
    const summary = (await new OwnerDb(fx.owner).listDemos()).find(
      (demo) => demo.demoId === demoId
    );
    expect(summary).toMatchObject({ state: 'VERIFIED', hostname: null, leaseIssuedAt: null });
    expect(await new OwnerDb(fx.owner).demoHostname(demoId)).toBeNull();
  });
});
