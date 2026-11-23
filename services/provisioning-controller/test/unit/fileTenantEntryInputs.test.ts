import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT,
  FileSlotKeys,
  FileTenantEntryInputs,
  MAX_INPUT_BYTES,
  parseRunConfig,
  runCli,
  type StepRequest,
  type TenantEntryFiles,
} from '../../src/index.js';
import { APPROVAL, ENTRY } from '../support/doubles.js';
import { Workdir } from '../support/workdir.js';

let work: Workdir;
beforeEach(async () => {
  work = await Workdir.create();
});
afterEach(async () => {
  await work.remove();
});

const SLOT = 'acme-blog';
const CANARY = 'CANARY-5f2e9c1d-value-that-must-never-be-logged';
const OWNER = 'owner@example.invalid';
const TEMPLATE =
  'GHOST_DB_PASSWORD=\nGHOST_OWNER_EMAIL=\nGHOST_ADMIN_KEY=\nGHOST_S3_ACCESS_KEY_ID=\n';
const KEY = '/etc/controller/entry_key';
const KNOWN = '/etc/controller/known_hosts';
const DIGEST = 'sha256:abababababababababababababababababababababababababababababababab';

const keys = (): FileSlotKeys => new FileSlotKeys(work.path('slot-keys'));

const request = (id: StepRequest['id'] = 'render-host-secrets', slot = SLOT): StepRequest => ({
  key: 'k',
  id,
  idempotencyKey: 'k@d',
  inputs: { slot },
});

async function files(modes: { secrets?: number; stack?: number } = {}): Promise<TenantEntryFiles> {
  return {
    secretsFile: await work.json(
      'secrets.json',
      { template: TEMPLATE, literals: { [SLOT]: { GHOST_OWNER_EMAIL: OWNER } } },
      modes.secrets ?? 0o600
    ),
    stackFile: await work.json(
      'stack.json',
      {
        [SLOT]: {
          size: 'small',
          mail: false,
          environment: { database__password: { secret: 'DB_PASSWORD' }, url: 'https://x.test' },
          owner: { name: 'Demo Owner', siteTitle: 'Demo site' },
        },
      },
      modes.stack ?? 0o600
    ),
  };
}

/** The files under `dir` (any depth) whose bytes hold `needle`, except those named in `except`. */
async function filesHolding(
  dir: string,
  needle: string,
  except: readonly string[]
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || except.includes(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path, 'utf8')).includes(needle)) found.push(path);
  }
  return found;
}

describe('FileTenantEntryInputs: what it reads', () => {
  it('returns the template and literals, the three stack parameters and the key, for the slot asked', async () => {
    const slotKeys = keys();
    await slotKeys.ensure(SLOT);
    const inputs = new FileTenantEntryInputs(await files(), slotKeys);
    expect(await inputs.secrets(request())).toEqual({
      template: TEMPLATE,
      values: { GHOST_OWNER_EMAIL: OWNER },
    });
    const claim = { uid: 20001, portA: 1, portB: 2, portHealth: 3 };
    expect(await inputs.stack(request('render-compose-file'), claim)).toEqual({
      size: 'small',
      mail: false,
      environment: { database__password: { secret: 'DB_PASSWORD' }, url: 'https://x.test' },
    });
    expect(await inputs.deployKey(request('create-app-host-slot'))).toBe(
      await slotKeys.publicKey(SLOT)
    );
  });

  it('refuses a slot with no entry, and a stack with a key it does not know', async () => {
    const f = await files();
    const inputs = new FileTenantEntryInputs(f, keys());
    // A slot with no literals needs none: the template may name no literal key.
    await expect(inputs.secrets(request('render-host-secrets', 'other-slot'))).resolves.toEqual({
      template: TEMPLATE,
      values: {},
    });
    await work.json('secrets.json', { template: 'x', values: { [SLOT]: { A: 'b' } } });
    await expect(inputs.secrets(request())).rejects.toThrow(/no longer reads/);
    await work.json('secrets.json', { template: 'x', literals: [] });
    await expect(inputs.secrets(request())).rejects.toThrow(/no "literals" object/);
    await work.json('stack.json', {
      [SLOT]: { size: 'small', mail: true, environment: {}, image: 'x' },
    });
    await expect(
      inputs.stack(request(), { uid: 1, portA: 1, portB: 2, portHealth: 3 })
    ).rejects.toThrow(/bad key \(image\)/);
  });
});

describe('FileTenantEntryInputs: the owner step', () => {
  it('reads the display name and title, the colour (a unless named) and the stack’s own address', async () => {
    const inputs = new FileTenantEntryInputs(await files(), keys());
    expect(await inputs.owner(request('create-owner-account'))).toEqual({
      colour: 'a',
      name: 'Demo Owner',
      siteUrl: 'https://x.test',
      siteTitle: 'Demo site',
    });
    await work.json('stack.json', {
      [SLOT]: {
        size: 'small',
        mail: false,
        environment: { url: 'https://y.test' },
        owner: { name: 'N', siteTitle: 'T', colour: 'b' },
      },
    });
    expect(await inputs.owner(request('create-owner-account'))).toEqual({
      colour: 'b',
      name: 'N',
      siteUrl: 'https://y.test',
      siteTitle: 'T',
    });
  });

  it('does not accept an address for the owner, whatever it is called, nor a bad shape', async () => {
    const inputs = new FileTenantEntryInputs(await files(), keys());
    const bad = async (stack: Record<string, unknown>, pattern: RegExp): Promise<void> => {
      await work.json('stack.json', { [SLOT]: { size: 'small', mail: false, ...stack } });
      await expect(inputs.owner(request('create-owner-account'))).rejects.toThrow(pattern);
    };
    const environment = { url: 'https://x.test' };
    await bad({ environment }, /bad shape/);
    await bad(
      { environment, owner: { name: 'N', siteTitle: 'T', email: 'someone@example.invalid' } },
      /bad key \(email\)/
    );
    await bad({ environment, owner: { name: 'N', siteTitle: 'T', colour: 'c' } }, /bad colour/);
    await bad({ environment, owner: { name: 7, siteTitle: 'T' } }, /bad name/);
    await bad({ environment: {}, owner: { name: 'N', siteTitle: 'T' } }, /bad site address/);
    await bad(
      { environment: { url: { secret: 'X' } }, owner: { name: 'N', siteTitle: 'T' } },
      /bad site address/
    );
  });
});

describe('FileTenantEntryInputs: the files must be trusted', () => {
  it('accepts a private file, and one its group can read', async () => {
    for (const mode of [0o600, 0o640]) {
      const inputs = new FileTenantEntryInputs(await files({ secrets: mode }), keys());
      await expect(inputs.secrets(request())).resolves.toBeDefined();
    }
  });

  it('refuses a secrets file that anyone other than the owner and its group can read or write', async () => {
    for (const mode of [0o604, 0o606, 0o620, 0o660, 0o666]) {
      const inputs = new FileTenantEntryInputs(await files({ secrets: mode }), keys());
      await expect(inputs.secrets(request())).rejects.toThrow(/its mode lets other users/);
    }
  });

  it('refuses a stack file that the group or others can write', async () => {
    for (const mode of [0o620, 0o602, 0o666]) {
      const inputs = new FileTenantEntryInputs(await files({ stack: mode }), keys());
      const claim = { uid: 1, portA: 1, portB: 2, portHealth: 3 };
      await expect(inputs.stack(request(), claim)).rejects.toThrow(/its mode lets other users/);
    }
  });

  it('refuses a file owned by a user that may not own it', async () => {
    const f = await files();
    const stranger = (process.getuid?.() ?? 0) + 4242;
    const inputs = new FileTenantEntryInputs(f, keys(), [stranger]);
    await expect(inputs.secrets(request())).rejects.toThrow(/may not own it/);
  });

  it('refuses a symbolic link, a directory and a file past the size bound', async () => {
    const f = await files();
    await symlink(f.secretsFile, work.path('link.json'));
    await mkdir(work.path('dir.json'));
    await writeFile(work.path('big.json'), ' '.repeat(MAX_INPUT_BYTES + 1));
    await chmod(work.path('big.json'), 0o600);
    const at = (secretsFile: string): FileTenantEntryInputs =>
      new FileTenantEntryInputs({ ...f, secretsFile }, keys());
    await expect(at(work.path('link.json')).secrets(request())).rejects.toThrow(/symbolic link/);
    await expect(at(work.path('dir.json')).secrets(request())).rejects.toThrow(
      /cannot be opened|not a regular file/
    );
    await expect(at(work.path('big.json')).secrets(request())).rejects.toThrow(/too large/);
    await expect(at(work.path('missing.json')).secrets(request())).rejects.toThrow(
      /cannot be opened/
    );
  });

  it('refuses a named pipe at once instead of waiting for a writer', async () => {
    const f = await files();
    const pipe = work.path('pipe.json');
    await promisify(execFile)('mkfifo', [pipe]);
    const inputs = new FileTenantEntryInputs(
      {
        ...f,
        secretsFile: pipe,
        stackFile: pipe,
      },
      keys()
    );
    const outcome = async (run: Promise<unknown>): Promise<string> => {
      const timer = new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 1500));
      return Promise.race([
        run.then(
          () => 'accepted',
          (e: Error) => e.message
        ),
        timer,
      ]);
    };
    try {
      expect(await outcome(inputs.secrets(request()))).toMatch(/not a regular file/);
    } finally {
      // Let a blocked open, if the guard is missing, finish so the test run can end.
      await open(pipe, constants.O_WRONLY | constants.O_NONBLOCK).then(
        (h) => h.close(),
        () => undefined
      );
    }
  });
});

describe('FileTenantEntryInputs: no value is ever in an error', () => {
  it('does not quote the file when it is not JSON, nor a value that is not text', async () => {
    const f = await files();
    const inputs = new FileTenantEntryInputs(f, keys());
    await writeFile(f.secretsFile, `{"template": "x", "literals": {"${SLOT}": {"A": "${CANARY}" `);
    const broken = await inputs.secrets(request()).then(
      () => '',
      (e: Error) => `${e.name} ${e.message}`
    );
    expect(broken).toContain('it is not JSON');
    expect(broken).not.toContain(CANARY);

    await work.json('secrets.json', { template: 'x', literals: { [SLOT]: { [CANARY]: 7 } } });
    const notText = await inputs.secrets(request()).then(
      () => '',
      (e: Error) => `${e.name} ${e.message}`
    );
    expect(notText).toContain('is not text');
    await work.json('secrets.json', { template: 'x', literals: { [SLOT]: 7 } });
    await expect(inputs.secrets(request())).rejects.toThrow(/are not an object/);
    expect(notText).not.toContain(CANARY);
  });
});

describe('the sshEntry.inputs configuration has no default', () => {
  const base = {
    stateFile: '/var/lib/controller/state.jsonl',
    approvalsFile: '/var/lib/controller/approvals.json',
    registerFile: '/var/lib/controller/register.json',
    hosts: {},
    dbEntry: {
      target: { user: 'tenantdb', host: 'db1.example.test' },
      handOverDir: '/var/lib/controller/hand-over',
    },
  };
  const ssh = (inputs: unknown): Record<string, unknown> => ({
    keyFile: KEY,
    knownHostsFile: KNOWN,
    jumpHops: [],
    target: { user: 'tenant-entry', host: 'app1.example.test' },
    ...(inputs !== undefined && { inputs }),
  });
  const good = { secretsFile: '/a/s.json', stackFile: '/a/t.json' };

  it('is parsed beside the transport settings', () => {
    const config = parseRunConfig({ ...base, sshEntry: ssh(good) });
    expect(config.tenantEntryFiles).toEqual(good);
  });

  it('is required, absolute, and closed to other keys', () => {
    expect(() => parseRunConfig({ ...base, sshEntry: ssh(undefined) })).toThrow(
      /sshEntry\.inputs is required/
    );
    expect(() =>
      parseRunConfig({ ...base, sshEntry: ssh({ ...good, secretsFile: 'secrets.json' }) })
    ).toThrow(/sshEntry\.inputs\.secretsFile is not an absolute path/);
    expect(() => parseRunConfig({ ...base, sshEntry: ssh({ ...good, extra: '/x' }) })).toThrow(
      /unknown keys: extra/
    );
    const { stackFile: _left, ...rest } = good;
    expect(() => parseRunConfig({ ...base, sshEntry: ssh(rest) })).toThrow(
      /sshEntry\.inputs\.stackFile is not an absolute path/
    );
  });
});

/** The host's forced command, as a stand-in ssh: remembers each verb's input, answers status from marker files. */
async function fakeSsh(dir: string): Promise<string> {
  const pinned = [
    'stricthostkeychecking true',
    'batchmode yes',
    'identitiesonly yes',
    `userknownhostsfile ${KNOWN}`,
    'globalknownhostsfile /dev/null',
    `identityfile ${KEY}`,
  ];
  await writeFile(`${dir}/g.out`, `${pinned.join('\n')}\n`);
  const lines = [
    '#!/bin/sh',
    `D=${dir}`,
    'echo "$*" >> $D/ssh-args.log',
    'if [ "$1" = "-G" ]; then cat $D/g.out; exit 0; fi',
    'case "$*" in *" deploy@"*) echo "$*" > $D/deploy-args.log; cat > $D/deploy-stdin.txt; exit 0 ;; esac',
    'for a in "$@"; do verb=$slug; slug=$a; done',
    'cat > $D/payload-$verb.json',
    'case $verb in',
    '  status)',
    '    if [ -f $D/claimed ]; then echo claimed-here=yes; echo uid=20001; echo port_a=20001; echo port_b=20002; echo port_health=20003; echo volumes=yes; else echo claimed-here=no; echo volumes=no; fi',
    '    for f in secrets stack enabled slot; do if [ -f $D/$f ]; then echo $f=yes; else echo $f=no; fi; done ;;',
    '  create-tenant-db)',
    '    if [ -f $D/dbexists ] || [ -f $D/dbmade ]; then echo "branchleft-tenant-db-entry: refused reason=exists" >&2; exit 3; fi',
    `    touch $D/dbmade; printf 'database=ghost_acme_blog\\nuser=ghost_acme_blog@10.20.1.201\\npassword=${CANARY}\\n' ;;`,
    '  claim) touch $D/claimed ;;',
    '  secrets) if [ -f $D/refuse ]; then echo "refused: bad-template" >&2; grep -o "CANARY[-a-z0-9]*" $D/payload-secrets.json >&2; exit 1; fi; touch $D/secrets ;;',
    '  stack) touch $D/stack ;;',
    '  enable) touch $D/enabled ;;',
    '  key) touch $D/slot ;;',
    '  owner) touch $D/owner ;;',
    'esac',
    'exit 0',
  ];
  const program = `${dir}/ssh`;
  await writeFile(program, `${lines.join('\n')}\n`);
  await chmod(program, 0o755);
  return program;
}

describe('runCli with the file adapter: the shipped wiring end to end', () => {
  interface Outcome {
    readonly code: number;
    readonly stdout: string[];
    readonly stderr: string[];
  }

  async function deploy(modes?: { secrets?: number }): Promise<string> {
    const f = await files(modes);
    const entry = { ...ENTRY, appHostSlot: SLOT, imageDigest: DIGEST };
    const handOver = work.path('hand-over');
    await mkdir(handOver, { mode: 0o700 });
    const config = await work.deployment({
      sshEntry: {
        keyFile: KEY,
        knownHostsFile: KNOWN,
        jumpHops: [{ user: 'jumper', host: 'edge1.example.test' }],
        sshConfigFile: '/etc/controller/ssh_config',
        target: { user: 'tenant-entry', host: 'app1.example.test' },
        sshProgram: await fakeSsh(work.dir),
        inputs: f,
      },
      dbEntry: { target: { user: 'tenantdb', host: 'db1.example.test' }, handOverDir: handOver },
    });
    await work.json('register.json', { entries: [entry] });
    return config;
  }

  async function run(config: string, withAdapter = true): Promise<Outcome> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(['--config', config, '--approval-id', APPROVAL.approvalId], {
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
      env: { PATH: process.env['PATH'] },
      ...(withAdapter && {
        tenantEntryInputs: (paths, slotKeys) => new FileTenantEntryInputs(paths, slotKeys),
      }),
    });
    return { code, stdout, stderr };
  }

  /** Everything the controller wrote or printed, which must never hold a secret value. */
  async function everythingLogged(o: Outcome): Promise<string> {
    const read = async (name: string): Promise<string> =>
      readFile(work.path(name), 'utf8').catch(() => '');
    return [
      o.stdout.join('\n'),
      o.stderr.join('\n'),
      await read('state.jsonl'),
      await read('calls.jsonl'),
      await read('ssh-args.log'),
    ].join('\n');
  }

  it('runs the whole approval over ssh: the host gets the minted password and generated values, and nothing logs one', async () => {
    const outcome = await run(await deploy());
    expect(outcome.code).toBe(EXIT.complete);
    const sent = JSON.parse(await readFile(work.path('payload-secrets.json'), 'utf8')) as {
      values: Record<string, string>;
    };
    expect(Object.keys(sent.values).sort()).toEqual(
      ['GHOST_ADMIN_KEY', 'GHOST_DB_PASSWORD', 'GHOST_OWNER_EMAIL', 'GHOST_S3_ACCESS_KEY_ID'].sort()
    );
    expect(sent.values['GHOST_DB_PASSWORD']).toBe(CANARY);
    expect(sent.values['GHOST_OWNER_EMAIL']).toBe(OWNER);
    expect(sent.values['GHOST_S3_ACCESS_KEY_ID']).toContain('placeholder-not-a-credential-');
    const generated = sent.values['GHOST_ADMIN_KEY'] ?? '';
    expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The key sent to the host is the public half of the pair the controller made.
    const made = await readFile(work.path(`slot-keys/${SLOT}.pub`), 'utf8');
    expect(await readFile(work.path('payload-key.json'), 'utf8')).toContain(made.trim());
    // The first deploy ran over the slot's own key, with the register's digest alone on stdin.
    expect(await readFile(work.path('deploy-stdin.txt'), 'utf8')).toBe(
      `ghcr.io/branchleft/ghost-tenant@${DIGEST}\n`
    );
    expect(await readFile(work.path('deploy-args.log'), 'utf8')).toContain(
      `-i ${work.path(`slot-keys/${SLOT}.key`)}`
    );
    expect(await readFile(work.path('deploy-args.log'), 'utf8')).toContain(
      'deploy@app1.example.test'
    );
    // The owner step sends the four fields it is allowed and nothing that could be an address.
    expect(JSON.parse(await readFile(work.path('payload-owner.json'), 'utf8'))).toEqual({
      colour: 'a',
      name: 'Demo Owner',
      site_url: 'https://x.test',
      site_title: 'Demo site',
    });
    const stack = await readFile(work.path('payload-stack.json'), 'utf8');
    expect(stack).not.toContain(CANARY);
    const logged = await everythingLogged(outcome);
    expect(logged).not.toContain(CANARY);
    expect(logged).not.toContain('PRIVATE KEY');
    expect(logged).not.toContain(generated);
    // The hand-over copy is gone, and the password is in no file but the stand-in host's received payload.
    expect(await readdir(work.path('hand-over'))).toEqual([]);
    expect(await filesHolding(work.dir, CANARY, ['ssh', 'payload-secrets.json'])).toEqual([]);
    expect(await filesHolding(work.dir, generated, ['payload-secrets.json'])).toEqual([]);
    expect(await work.calledIds()).not.toContain('render-host-secrets');
    expect(await work.calledIds()).not.toContain('create-database');
  });

  it('starts in the binary’s shape only when the deployment supplies the adapter', async () => {
    const outcome = await run(await deploy(), false);
    expect(outcome.code).toBe(EXIT.usage);
    expect(outcome.stderr.join('\n')).toContain('no source of the tenant entry inputs');
  });

  it('stops the step, not the host, over a secrets file others can read, and logs no value', async () => {
    const outcome = await run(await deploy({ secrets: 0o644 }));
    expect(outcome.code).toBe(EXIT.stopped);
    const logged = await everythingLogged(outcome);
    expect(logged).toContain('its mode lets other users');
    expect(logged).not.toContain(CANARY);
    await expect(readFile(work.path('payload-secrets.json'), 'utf8')).rejects.toThrow();
  });

  it('logs no value when the host refuses and echoes what it was sent', async () => {
    const config = await deploy();
    await writeFile(work.path('refuse'), '');
    const outcome = await run(config);
    expect(outcome.code).toBe(EXIT.stopped);
    const logged = await everythingLogged(outcome);
    expect(logged).toContain('refused');
    expect(logged).not.toContain(CANARY);
    // The password is held for the retry, in the one private file, and nowhere else.
    expect(await readdir(work.path('hand-over'))).toEqual(['db-handover-acme-blog.json']);
    expect(await filesHolding(work.dir, CANARY, ['ssh', 'payload-secrets.json'])).toEqual([
      work.path('hand-over/db-handover-acme-blog.json'),
    ]);
    // The host takes the secrets on the next run, which makes no second database and drops the copy.
    await rm(work.path('refuse'));
    await rm(work.path('state.jsonl'));
    const again = await run(config);
    expect(again.code).toBe(EXIT.complete);
    expect(await readdir(work.path('hand-over'))).toEqual([]);
    expect(await everythingLogged(again)).not.toContain(CANARY);
  });
});
