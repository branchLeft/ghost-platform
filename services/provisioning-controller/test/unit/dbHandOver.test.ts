import { link, mkdir, readdir, readFile, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DB_EXIT,
  DbEntryHost,
  FileDatabaseHandOver,
  FileStateStore,
  GeneratedTenantEntryInputs,
  PLACEHOLDER_PREFIX,
  PermanentStepError,
  executeOnboarding,
  templateKeys,
  TenantEntryHost,
  type DatabaseHandOver,
  type DbEntryTransport,
  type EntryClaim,
  type EntryReply,
  type EntryTransport,
  type EntryVerb,
  type ExecutePorts,
  type RecordedApproval,
  type RegisterEntry,
  type StackParameters,
  type StateRecord,
  type StateStore,
  type StepRequest,
  type TenantEntryInputs,
} from '../../src/index.js';
import { Killed, World } from '../support/doubles.js';
import { Workdir } from '../support/workdir.js';

const DEMO: RegisterEntry = {
  tenantId: 'demo-tenant',
  mediaFolder: 'demo-tenant',
  stateFolder: 'STATE_FOLDER_PLACEHOLDER',
  mediaBucket: 'branchleft-media-demo-tenant',
  appHostSlot: 'demo-tenant',
  appHostPort: 8101,
  appHostUid: 30001,
  hostnames: ['demo-tenant.sites.example.invalid'],
};
const APPROVAL: RecordedApproval = {
  approvalId: 'DEMO_APPROVAL_PLACEHOLDER',
  tenantId: DEMO.tenantId,
  approvedAt: '2026-01-01T00:00:00Z',
  scopes: ['setup', 'web-address', 'first-deploy'],
};

/** What db-t1 prints once: the one value that must never be anywhere but the app host's secrets file. */
const PASSWORD = 'DBPW-9f1c2b7a4e6d4f0a8c3b5e7d1a2f4c6b8e0d';
const OWNER = 'owner@example.invalid';
const TEMPLATE =
  '# Secrets for the stack.\nGHOST_DB_PASSWORD=\nGHOST_S3_ACCESS_KEY_ID=\nGHOST_S3_SECRET_ACCESS_KEY=\nGHOST_OWNER_EMAIL=\nGHOST_ADMIN_KEY=\n';
const CLAIM: EntryClaim = { uid: 30000, portA: 40000, portB: 40001, portHealth: 40002 };

let work: Workdir;
let handDir: string;
beforeEach(async () => {
  work = await Workdir.create();
  handDir = work.path('hand-over');
  await mkdir(handDir, { mode: 0o700 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await work.remove();
});

const reply = (code: number, stdout = '', stderr = ''): EntryReply => ({ code, stdout, stderr });
const created = (name = 'demo-tenant', password = PASSWORD): EntryReply =>
  reply(
    0,
    `database=ghost_${name.replace(/-/g, '_')}\nuser=ghost_${name.replace(/-/g, '_')}@10.20.1.201\npassword=${password}\n`
  );

/** A stand-in for db-t1's program: one database per name, the password printed once, a second create refused. */
class FakeDb implements DbEntryTransport {
  readonly sent: string[] = [];
  readonly made = new Set<string>();
  forced: EntryReply | undefined;
  async send(verb: 'create-tenant-db', name: string): Promise<EntryReply> {
    this.sent.push(`${verb} ${name}`);
    if (this.forced !== undefined) return this.forced;
    if (this.made.has(name)) {
      return reply(DB_EXIT.exists, '', 'branchleft-tenant-db-entry: refused reason=exists\n');
    }
    this.made.add(name);
    return created(name);
  }
}

/** A stand-in for the app host's program, keeping the values the secrets verb was sent. */
class FakeApp implements EntryTransport {
  readonly verbs: EntryVerb[] = [];
  received: Readonly<Record<string, string>> | undefined;
  private claimed = false;
  private secrets = false;
  private stack = false;
  private enabled = false;
  private slot = false;
  /** Replies to the secrets verb with this code (and takes nothing) while it is above zero. */
  failSecrets = 0;
  async send(
    verb: EntryVerb,
    slug: string,
    payload?: Readonly<Record<string, unknown>>
  ): Promise<EntryReply> {
    void slug;
    if (verb !== 'status') this.verbs.push(verb);
    const yn = (b: boolean): string => (b ? 'yes' : 'no');
    switch (verb) {
      case 'status':
        return this.claimed
          ? reply(
              0,
              [
                'claimed-here=yes',
                `uid=${CLAIM.uid}`,
                `port_a=${CLAIM.portA}`,
                `port_b=${CLAIM.portB}`,
                `port_health=${CLAIM.portHealth}`,
                'volumes=yes',
                `secrets=${yn(this.secrets)}`,
                `stack=${yn(this.stack)}`,
                `enabled=${yn(this.enabled)}`,
                `slot=${yn(this.slot)}`,
              ].join('\n') + '\n'
            )
          : reply(0, 'claimed-here=no\n');
      case 'claim':
        this.claimed = true;
        return reply(0, 'claimed\n');
      case 'secrets':
        if (this.failSecrets > 0) {
          this.failSecrets -= 1;
          return reply(4, '', 'the secrets step failed\n');
        }
        this.received = (payload as { values: Record<string, string> }).values;
        this.secrets = true;
        return reply(0, 'written\n');
      case 'stack':
        this.stack = true;
        return reply(0, 'written\n');
      case 'enable':
        this.enabled = true;
        return reply(0, 'enabled\n');
      case 'key':
        this.slot = true;
        return reply(0, 'granted\n');
      default:
        return reply(1, '', 'refused: unknown-verb\n');
    }
  }
}

/** The non-secret inputs a deployment gives: the template, the owner's address, the stack and the key. */
class BaseInputs implements TenantEntryInputs {
  deliveredCount = 0;
  async secrets(): Promise<{ template: string; values: Record<string, string> }> {
    return { template: TEMPLATE, values: { GHOST_OWNER_EMAIL: OWNER } };
  }
  async stack(): Promise<StackParameters> {
    return { size: 'small', mail: false, environment: { url: 'https://x.test' } };
  }
  async deployKey(): Promise<string> {
    return 'ssh-ed25519 AAAAPUBLIC deploy';
  }
  async delivered(): Promise<void> {
    this.deliveredCount += 1;
  }
}

/** Values that are easy to find in a scan. */
function counter(): () => string {
  let n = 0;
  return () =>
    `GENERATED-${String((n += 1)).padStart(2, '0')}-0123456789abcdefghijklmnopqrstuvwxyz`;
}

const request = (id: StepRequest['id'], slot = 'demo-tenant'): StepRequest => ({
  key: `${DEMO.tenantId}/${id}`,
  id,
  idempotencyKey: `${DEMO.tenantId}/${id}@digest`,
  inputs: { slot },
});

describe('FileDatabaseHandOver: one private file per slot', () => {
  it('holds the password in a 0600 file, reads it back, and removes it', async () => {
    const hand = new FileDatabaseHandOver(handDir);
    expect(await hand.has('demo-tenant')).toBe(false);
    expect(await hand.read('demo-tenant')).toBeUndefined();
    await hand.store('demo-tenant', PASSWORD);
    expect(await readdir(handDir)).toEqual(['db-handover-demo-tenant.json']);
    const info = await stat(join(handDir, 'db-handover-demo-tenant.json'));
    expect(info.mode & 0o777).toBe(0o600);
    expect(await hand.has('demo-tenant')).toBe(true);
    expect(await hand.read('demo-tenant')).toBe(PASSWORD);
    await hand.discard('demo-tenant');
    expect(await readdir(handDir)).toEqual([]);
    await hand.discard('demo-tenant');
    expect(await hand.has('demo-tenant')).toBe(false);
  });

  it('never replaces a held copy, and holds only a credential in db-t1’s shape', async () => {
    const hand = new FileDatabaseHandOver(handDir);
    await hand.store('demo-tenant', PASSWORD);
    await expect(hand.store('demo-tenant', 'OTHER-0123456789abcdef')).rejects.toBeInstanceOf(
      PermanentStepError
    );
    expect(await hand.read('demo-tenant')).toBe(PASSWORD);
    expect(await readdir(handDir)).toEqual(['db-handover-demo-tenant.json']);
    for (const bad of ['', 'short', 'has space in it 0123456789', 'new\nline-0123456789abcdef']) {
      await expect(hand.store('other', bad)).rejects.toThrow(/not in a form/);
    }
    expect(await readdir(handDir)).toEqual(['db-handover-demo-tenant.json']);
  });

  it('refuses a slot that is not a slot name', async () => {
    const hand = new FileDatabaseHandOver(handDir);
    for (const slot of ['', '../x', 'a/b', '.hidden', 'a b']) {
      await expect(hand.has(slot)).rejects.toThrow(/not a valid slot name/);
    }
  });

  it('refuses a copy that is a link, wider than private, linked twice, or not one credential', async () => {
    const hand = new FileDatabaseHandOver(handDir);
    const copy = join(handDir, 'db-handover-demo-tenant.json');
    const text = JSON.stringify({ password: PASSWORD });

    await writeFile(join(work.dir, 'elsewhere.json'), text, { mode: 0o600 });
    await symlink(join(work.dir, 'elsewhere.json'), copy);
    await expect(hand.read('demo-tenant')).rejects.toThrow(/symbolic link/);
    await hand.discard('demo-tenant');

    await writeFile(copy, text, { mode: 0o600 });
    await chmod(copy, 0o640);
    await expect(hand.read('demo-tenant')).rejects.toThrow(/mode lets other users/);
    await chmod(copy, 0o600);

    await link(copy, join(work.dir, 'second-name.json'));
    await expect(hand.read('demo-tenant')).rejects.toThrow(/more than one link/);
    await hand.discard('demo-tenant');

    for (const body of [
      'not json',
      '[]',
      JSON.stringify({ password: PASSWORD, extra: 1 }),
      JSON.stringify({ password: 'short' }),
      JSON.stringify({ password: 7 }),
    ]) {
      await writeFile(copy, body, { mode: 0o600 });
      const message = await hand.read('demo-tenant').then(
        () => '',
        (e: Error) => e.message
      );
      expect(message).toMatch(/not JSON|does not hold one database credential/);
      expect(message).not.toContain(PASSWORD);
      await hand.discard('demo-tenant');
    }

    await writeFile(copy, 'x'.repeat(5000), { mode: 0o600 });
    await expect(hand.read('demo-tenant')).rejects.toThrow(/too large/);
    await hand.discard('demo-tenant');
    await mkdir(copy);
    await expect(hand.read('demo-tenant')).rejects.toThrow(/not a regular file/);
  });

  it('refuses a copy another user owns', async () => {
    const stranger = new FileDatabaseHandOver(handDir, (process.getuid?.() ?? 0) + 4242);
    expect(await stranger.problems()).toEqual([expect.stringMatching(/belongs to another user/)]);
    await expect(stranger.has('demo-tenant')).rejects.toThrow(/belongs to another user/);
  });

  it('names a directory that is missing, a link, a file, or open to others', async () => {
    expect(await new FileDatabaseHandOver(handDir).problems()).toEqual([]);
    expect(await new FileDatabaseHandOver(work.path('missing')).problems()).toEqual([
      expect.stringMatching(/cannot be read/),
    ]);
    await symlink(handDir, work.path('link'));
    expect(await new FileDatabaseHandOver(work.path('link')).problems()).toEqual([
      expect.stringMatching(/symbolic link/),
    ]);
    await writeFile(work.path('plain'), '');
    expect(await new FileDatabaseHandOver(work.path('plain')).problems()).toEqual([
      expect.stringMatching(/not a directory/),
    ]);
    for (const mode of [0o770, 0o707, 0o722]) {
      await chmod(handDir, mode);
      expect(await new FileDatabaseHandOver(handDir).problems()).toEqual([
        expect.stringMatching(/write or reach it/),
      ]);
    }
    await chmod(handDir, 0o750);
    expect(await new FileDatabaseHandOver(handDir).problems()).toEqual([]);
    await chmod(handDir, 0o700);
  });

  it('leaves no temporary file behind when a copy cannot be linked in', async () => {
    const hand = new FileDatabaseHandOver(handDir);
    await mkdir(join(handDir, 'db-handover-demo-tenant.json'));
    await expect(hand.store('demo-tenant', PASSWORD)).rejects.toBeInstanceOf(PermanentStepError);
    expect(await readdir(handDir)).toEqual(['db-handover-demo-tenant.json']);
  });
});

describe('DbEntryHost: db-t1’s program, and the one place the password goes', () => {
  function rig(): { db: FakeDb; hand: FileDatabaseHandOver; host: DbEntryHost } {
    const db = new FakeDb();
    const hand = new FileDatabaseHandOver(handDir);
    return { db, hand, host: new DbEntryHost({ transport: db, handOver: hand }) };
  }
  const message = async (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => '',
      (e: Error) => `${e.name}: ${e.message}`
    );

  it('sends create-tenant-db with the slot, holds the password, and returns nothing', async () => {
    const { db, hand, host } = rig();
    await expect(host.run(request('create-database'))).resolves.toBeUndefined();
    expect(db.sent).toEqual(['create-tenant-db demo-tenant']);
    expect(await hand.read('demo-tenant')).toBe(PASSWORD);
  });

  it('sends nothing when the copy is already held, so a resume makes no second database', async () => {
    const { db, hand, host } = rig();
    await hand.store('demo-tenant', PASSWORD);
    await host.run(request('create-database'));
    expect(db.sent).toEqual([]);
  });

  it('turns a refused request, an existing name and a bad reply into permanent errors that hold no value', async () => {
    const { db, hand, host } = rig();
    db.forced = reply(DB_EXIT.refused, '', 'branchleft-tenant-db-entry: refused reason=bad-name\n');
    expect(await message(host.run(request('create-database')))).toMatch(
      /PermanentStepError: .*refused create-tenant-db with bad-name$/
    );
    db.forced = reply(DB_EXIT.exists, '', 'branchleft-tenant-db-entry: refused reason=exists\n');
    expect(await message(host.run(request('create-database')))).toMatch(
      /PermanentStepError: .*with exists, and no copy of the credential is held here/
    );
    // A success whose lines are not the three it prints, with the password in them.
    const bad = [
      `database=ghost_demo_tenant\nuser=ghost_demo_tenant@10.20.1.201\n`,
      `database=ghost_other\nuser=ghost_other@10.20.1.201\npassword=${PASSWORD}\n`,
      `database=ghost_demo_tenant\nuser=someone@10.20.1.201\npassword=${PASSWORD}\n`,
      `database=ghost_demo_tenant\nuser=ghost_demo_tenant@10.20.1.201\npassword=${PASSWORD}\npassword=${PASSWORD}\n`,
      `database=ghost_demo_tenant\nuser=ghost_demo_tenant@10.20.1.201\npassword=${PASSWORD}\nextra=1\n`,
      `database=ghost_demo_tenant\nuser=ghost_demo_tenant@10.20.1.201\nthe ${PASSWORD}\n`,
      `database=ghost_demo_tenant\nuser=ghost_demo_tenant@10.20.1.201\npassword=short\n`,
    ];
    for (const stdout of bad) {
      db.forced = reply(0, stdout);
      const text = await message(host.run(request('create-database')));
      expect(text).toMatch(/PermanentStepError: the db host's reply is not the three lines/);
      expect(text).not.toContain(PASSWORD);
    }
    expect(await hand.has('demo-tenant')).toBe(false);
  });

  it('retries a busy host, a failed database and a code it does not know, naming only the fixed reason', async () => {
    const { db, host } = rig();
    db.forced = reply(DB_EXIT.busy, '', 'branchleft-tenant-db-entry: refused reason=busy\n');
    const busy = await message(host.run(request('create-database')));
    expect(busy).toBe('Error: db host create-tenant-db is busy');
    db.forced = reply(
      DB_EXIT.failed,
      PASSWORD,
      'branchleft-tenant-db-entry: failed reason=sql-failed\n'
    );
    const failed = await message(host.run(request('create-database')));
    expect(failed).toBe('Error: db host create-tenant-db failed (sql-failed)');
    db.forced = reply(9, '', `garbage ${PASSWORD}`);
    const unknown = await message(host.run(request('create-database')));
    expect(unknown).toBe('Error: db host create-tenant-db failed (unreadable)');
  });

  it('refuses a slot the program would not accept, and any other step', async () => {
    const { db, host } = rig();
    for (const slot of ['Demo', '1abc', 'a_b', 'abc-', 'a'.repeat(27)]) {
      await expect(host.run(request('create-database', slot))).rejects.toBeInstanceOf(
        PermanentStepError
      );
    }
    await expect(host.run({ ...request('create-database'), inputs: {} })).rejects.toBeInstanceOf(
      PermanentStepError
    );
    await expect(host.run(request('render-host-secrets'))).rejects.toThrow(/does not serve step/);
    expect(db.sent).toEqual([]);
  });

  it('says the database was made but not held when the copy cannot be written, without the value', async () => {
    const { db, hand, host } = rig();
    await chmod(handDir, 0o500);
    await chmod(handDir, 0o700);
    vi.spyOn(hand, 'store').mockRejectedValue(new Error(`disk ${PASSWORD}`));
    const text = await message(host.run(request('create-database')));
    expect(text).toMatch(/PermanentStepError: the database for slot demo-tenant was made/);
    expect(text).not.toContain(PASSWORD);
    expect(db.made.has('demo-tenant')).toBe(true);
  });
});

describe('GeneratedTenantEntryInputs: who makes each secret', () => {
  async function filled(hand: DatabaseHandOver, base = new BaseInputs()) {
    return new GeneratedTenantEntryInputs(base, hand, counter()).secrets(
      request('render-host-secrets')
    );
  }

  it('takes the database password from the hand-over, generates the rest, and keeps the owner’s address', async () => {
    const hand = new FileDatabaseHandOver(handDir);
    await hand.store('demo-tenant', PASSWORD);
    const { template, values } = await filled(hand);
    expect(template).toBe(TEMPLATE);
    expect(values).toEqual({
      GHOST_DB_PASSWORD: PASSWORD,
      GHOST_S3_ACCESS_KEY_ID: `${PLACEHOLDER_PREFIX}GENERATED-01-0123456789abcdefghijklmnopqrstuvwxyz`,
      GHOST_S3_SECRET_ACCESS_KEY: `${PLACEHOLDER_PREFIX}GENERATED-02-0123456789abcdefghijklmnopqrstuvwxyz`,
      GHOST_OWNER_EMAIL: OWNER,
      GHOST_ADMIN_KEY: 'GENERATED-03-0123456789abcdefghijklmnopqrstuvwxyz',
    });
  });

  it('uses the operating system’s random source by default, and each value differs', async () => {
    const hand = new FileDatabaseHandOver(handDir);
    await hand.store('demo-tenant', PASSWORD);
    const make = async (): Promise<Record<string, string>> =>
      (
        await new GeneratedTenantEntryInputs(new BaseInputs(), hand).secrets(
          request('render-host-secrets')
        )
      ).values as Record<string, string>;
    const [one, two] = [await make(), await make()];
    expect(one['GHOST_ADMIN_KEY']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(one['GHOST_ADMIN_KEY']).not.toBe(two['GHOST_ADMIN_KEY']);
    expect(one['GHOST_ADMIN_KEY']).not.toBe(one['GHOST_S3_ACCESS_KEY_ID']);
  });

  it('refuses to fill the secrets before a credential is held for the slot', async () => {
    await expect(filled(new FileDatabaseHandOver(handDir))).rejects.toThrow(
      /no database credential is held for slot demo-tenant/
    );
  });

  it('refuses a typed value for a secret, for a key the template lacks, and a missing owner address', async () => {
    const hand = new FileDatabaseHandOver(handDir);
    await hand.store('demo-tenant', PASSWORD);
    const withValues = (values: Record<string, string>, template = TEMPLATE): BaseInputs => {
      const base = new BaseInputs();
      base.secrets = async () => ({ template, values });
      return base;
    };
    await expect(
      filled(hand, withValues({ GHOST_OWNER_EMAIL: OWNER, GHOST_DB_PASSWORD: 'x' }))
    ).rejects.toThrow(/value for GHOST_DB_PASSWORD, which the controller fills itself/);
    await expect(
      filled(hand, withValues({ GHOST_OWNER_EMAIL: OWNER, GHOST_ADMIN_KEY: 'x' }))
    ).rejects.toThrow(/GHOST_ADMIN_KEY, which the controller fills itself/);
    const stray = await filled(
      hand,
      withValues({ GHOST_OWNER_EMAIL: OWNER, [PASSWORD]: 'x' })
    ).then(
      () => '',
      (e: Error) => e.message
    );
    expect(stray).toMatch(/a key the template does not name/);
    expect(stray).not.toContain(PASSWORD);
    await expect(filled(hand, withValues({}))).rejects.toThrow(/no value for GHOST_OWNER_EMAIL/);
  });

  it('reads a template as comments, blank lines and KEY= lines only', () => {
    expect(templateKeys(TEMPLATE)).toEqual([
      'GHOST_DB_PASSWORD',
      'GHOST_S3_ACCESS_KEY_ID',
      'GHOST_S3_SECRET_ACCESS_KEY',
      'GHOST_OWNER_EMAIL',
      'GHOST_ADMIN_KEY',
    ]);
    expect(() => templateKeys('A=1\n')).toThrow(/line the controller cannot fill/);
    expect(() => templateKeys('A=\nA=\n')).toThrow(/names A twice/);
    expect(() => templateKeys('# only\n\n')).toThrow(/names no key/);
  });

  it('drops the copy when the host has the secrets, passes the other inputs through, and needs a slot', async () => {
    const hand = new FileDatabaseHandOver(handDir);
    const base = new BaseInputs();
    const inputs = new GeneratedTenantEntryInputs(base, hand, counter());
    await hand.store('demo-tenant', PASSWORD);
    await inputs.delivered(request('render-host-secrets'));
    expect(await hand.has('demo-tenant')).toBe(false);
    expect(base.deliveredCount).toBe(1);
    expect(await inputs.deployKey(request('create-app-host-slot'))).toMatch(/^ssh-ed25519/);
    expect((await inputs.stack(request('render-compose-file'), CLAIM)).size).toBe('small');
    const noSlot = { ...request('render-host-secrets'), inputs: {} };
    await expect(inputs.secrets(noSlot)).rejects.toThrow(/no slot to act on/);
  });
});

/** Everything a run could write or print, for a scan. */
interface Surfaces {
  readonly written: string[];
}

function captureOutput(): Surfaces {
  const written: string[] = [];
  const take = (...args: unknown[]): boolean => {
    written.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(take as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(take as typeof process.stderr.write);
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation(take);
  }
  return { written };
}

/** The files under `dir` (any depth) whose bytes hold `needle`. */
async function filesHolding(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path, 'utf8')).includes(needle)) found.push(path);
  }
  return found;
}

describe('the whole run: the password goes db-t1 to app-t1 and nowhere else', () => {
  interface Flow {
    readonly db: FakeDb;
    readonly app: FakeApp;
    readonly world: World;
    readonly hand: FileDatabaseHandOver;
    readonly ports: ExecutePorts;
    readonly output: Surfaces;
  }

  function flow(store?: StateStore): Flow {
    const output = captureOutput();
    const db = new FakeDb();
    const app = new FakeApp();
    const world = new World();
    world.entry = DEMO;
    world.approval = APPROVAL;
    const hand = new FileDatabaseHandOver(handDir);
    const base = world.ports(store ?? new FileStateStore(work.path('state.jsonl')));
    const inputs = new GeneratedTenantEntryInputs(new BaseInputs(), hand, counter());
    return {
      db,
      app,
      world,
      hand,
      output,
      ports: {
        ...base,
        hosts: {
          ...base.hosts,
          'db-host': new DbEntryHost({ transport: db, handOver: hand }),
          'app-host': new TenantEntryHost({
            transport: app,
            inputs,
            fallback: base.hosts['app-host'],
          }),
        },
      },
    };
  }

  /** The names of the surfaces in which any of the values appears; the app host's own receipt is not one. */
  async function leaks(f: Flow, values: readonly string[]): Promise<string[]> {
    const places: Record<string, string> = {
      output: f.output.written.join('\n'),
      events: JSON.stringify(f.world.events),
    };
    const found: string[] = [];
    for (const [name, text] of Object.entries(places)) {
      if (values.some((v) => text.includes(v))) found.push(name);
    }
    for (const value of values) {
      for (const path of await filesHolding(work.dir, value))
        found.push(path.slice(work.dir.length));
    }
    return found;
  }

  const generatedOf = (f: Flow): string[] =>
    Object.entries(f.app.received ?? {})
      .filter(([name]) => name !== 'GHOST_OWNER_EMAIL')
      .map(([, value]) => value);

  it('completes, delivers the minted password and generated values, and leaves nothing behind', async () => {
    const f = flow();
    const result = await executeOnboarding(APPROVAL.approvalId, f.ports);
    expect(result.status).toBe('complete');
    expect(f.db.sent).toEqual(['create-tenant-db demo-tenant']);
    expect(f.app.received?.['GHOST_DB_PASSWORD']).toBe(PASSWORD);
    expect(Object.keys(f.app.received ?? {})).toHaveLength(5);
    expect(await readdir(handDir)).toEqual([]);
    // The one place the values may be is the app host's receipt, which is not a file of the controller's.
    expect(await leaks(f, [PASSWORD, ...generatedOf(f).filter((v) => v !== OWNER)])).toEqual([]);
    expect(await readFile(work.path('state.jsonl'), 'utf8')).toContain('create-database');
  });

  it('is found by the scan when a value is written to the output on purpose (the scan is not blind)', async () => {
    const f = flow();
    await executeOnboarding(APPROVAL.approvalId, f.ports);
    f.output.written.push(`oops ${PASSWORD}`);
    expect(await leaks(f, [PASSWORD])).toEqual(['output']);
    const admin = f.app.received?.['GHOST_ADMIN_KEY'] ?? '';
    await writeFile(work.path('stray.log'), `x ${admin}`);
    expect(await leaks(f, [admin])).toEqual(['/stray.log']);
  });

  it('resumes after a crash between the create and the secrets, with no second create and no copy left', async () => {
    const f = flow();
    f.app.failSecrets = 99;
    const first = await executeOnboarding(APPROVAL.approvalId, f.ports, {
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    expect(first.status).toBe('stopped');
    expect(first.stoppedAt?.key).toBe('demo-tenant/render-host-secrets');
    // db-t1 made the database and only the controller's own private file holds the password.
    expect(f.db.sent).toHaveLength(1);
    expect(await readdir(handDir)).toEqual(['db-handover-demo-tenant.json']);
    expect(await filesHolding(work.dir, PASSWORD)).toEqual([
      join(handDir, 'db-handover-demo-tenant.json'),
    ]);

    f.app.failSecrets = 0;
    const second = await executeOnboarding(APPROVAL.approvalId, f.ports);
    expect(second.status).toBe('complete');
    expect(f.db.sent).toHaveLength(1);
    expect(f.app.received?.['GHOST_DB_PASSWORD']).toBe(PASSWORD);
    expect(await readdir(handDir)).toEqual([]);
    expect(await leaks(f, [PASSWORD, ...generatedOf(f).filter((v) => v !== OWNER)])).toEqual([]);
  });

  it('resumes after the process dies with the database made but its step not recorded', async () => {
    const records: StateRecord[] = [];
    let killed = false;
    const store: StateStore = {
      readAll: async () => [...records],
      append: async (record) => {
        if (
          !killed &&
          record.event === 'complete' &&
          record.key?.endsWith('/create-database') === true
        ) {
          killed = true;
          throw new Killed();
        }
        records.push(record);
      },
    };
    const f = flow(store);
    await expect(executeOnboarding(APPROVAL.approvalId, f.ports)).rejects.toThrow(
      /did not accept a record/
    );
    expect(f.db.sent).toHaveLength(1);
    expect(await readdir(handDir)).toEqual(['db-handover-demo-tenant.json']);

    const second = await executeOnboarding(APPROVAL.approvalId, f.ports);
    expect(second.status).toBe('complete');
    expect(f.db.sent).toHaveLength(1);
    expect(f.app.received?.['GHOST_DB_PASSWORD']).toBe(PASSWORD);
    expect(await readdir(handDir)).toEqual([]);
    expect(JSON.stringify(records)).not.toContain(PASSWORD);
  });

  it('drops a copy the host no longer needs when it already has the secrets', async () => {
    const f = flow();
    await executeOnboarding(APPROVAL.approvalId, f.ports);
    await f.hand.store('demo-tenant', PASSWORD);
    await f.ports.hosts['app-host'].run(request('render-host-secrets'));
    expect(await readdir(handDir)).toEqual([]);
  });

  it('stops the run, with no value in any record, when db-t1 says the name exists and no copy is held', async () => {
    const f = flow();
    f.db.made.add('demo-tenant');
    const result = await executeOnboarding(APPROVAL.approvalId, f.ports);
    expect(result.status).toBe('stopped');
    expect(result.stoppedAt?.key).toBe('demo-tenant/create-database');
    expect(await readdir(handDir)).toEqual([]);
    expect(f.app.verbs).toEqual([]);
    expect(await leaks(f, [PASSWORD])).toEqual([]);
  });
});
