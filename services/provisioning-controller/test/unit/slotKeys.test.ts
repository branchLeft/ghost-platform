import { execFile } from 'node:child_process';
import { chmod, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileSlotKeys,
  GeneratedTenantEntryInputs,
  MEDIA_PLACEHOLDER_NAMES,
  PLACEHOLDER_KEYS,
  PLACEHOLDER_PREFIX,
  PermanentStepError,
  generateOpenSshPair,
  isPlaceholder,
  type DatabaseHandOver,
  type StepRequest,
  type TenantEntryInputs,
} from '../../src/index.js';
import { Workdir } from '../support/workdir.js';

let work: Workdir;
beforeEach(async () => {
  work = await Workdir.create();
});
afterEach(async () => {
  await work.remove();
});

const run = promisify(execFile);
const SLOT = 'slot-one';

describe('generateOpenSshPair', () => {
  it('makes a key the real ssh tools read, whose public half is the line it returns', async () => {
    const pair = generateOpenSshPair();
    expect(pair.publicLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
    const file = work.path('k');
    await writeFile(file, pair.privateText, { mode: 0o600 });
    const derived = await run('ssh-keygen', ['-y', '-f', file]);
    expect(derived.stdout.trim()).toBe(pair.publicLine);
    const shown = await run('ssh-keygen', ['-l', '-f', file]);
    expect(shown.stdout).toContain('ED25519');
  });

  it('makes a different pair every time', () => {
    expect(generateOpenSshPair().publicLine).not.toBe(generateOpenSshPair().publicLine);
  });
});

describe('FileSlotKeys', () => {
  const keys = (): FileSlotKeys => new FileSlotKeys(work.path('slot-keys'));

  it('makes the pair once, private and in a private directory, and never again', async () => {
    await keys().ensure(SLOT);
    const mode = async (p: string): Promise<number> => (await stat(work.path(p))).mode & 0o777;
    expect(await mode('slot-keys')).toBe(0o700);
    expect(await mode(`slot-keys/${SLOT}.key`)).toBe(0o600);
    expect(await mode(`slot-keys/${SLOT}.pub`)).toBe(0o600);
    const first = await readFile(work.path(`slot-keys/${SLOT}.key`), 'utf8');
    const publicKey = await keys().publicKey(SLOT);
    await keys().ensure(SLOT);
    expect(await readFile(work.path(`slot-keys/${SLOT}.key`), 'utf8')).toBe(first);
    expect(await keys().publicKey(SLOT)).toBe(publicKey);
    expect(await keys().privateKeyPath(SLOT)).toBe(work.path(`slot-keys/${SLOT}.key`));
  });

  it('gives each slot its own pair', async () => {
    await keys().ensure('slot-one');
    await keys().ensure('slot-two');
    expect(await keys().publicKey('slot-one')).not.toBe(await keys().publicKey('slot-two'));
  });

  it('refuses a slot that names a path, and a pair that was never made', async () => {
    for (const bad of ['../x', 'a/b', '', '.hidden', 'a b']) {
      await expect(keys().ensure(bad)).rejects.toBeInstanceOf(PermanentStepError);
    }
    await expect(keys().publicKey(SLOT)).rejects.toThrow(/has not been made/);
    await expect(keys().privateKeyPath(SLOT)).rejects.toThrow(/has not been made/);
  });

  it('replaces nothing: half a pair is refused, a loose or linked file is refused', async () => {
    await keys().ensure(SLOT);
    const pub = work.path(`slot-keys/${SLOT}.pub`);
    await chmod(pub, 0o644);
    await expect(keys().publicKey(SLOT)).rejects.toThrow(/other users/);
    await chmod(pub, 0o600);

    await writeFile(work.path(`slot-keys/half.key`), 'x', { mode: 0o600 });
    await expect(keys().ensure('half')).rejects.toThrow(/half a key pair/);

    await symlink(pub, work.path('slot-keys/linked.pub'));
    await expect(keys().publicKey('linked')).rejects.toBeInstanceOf(PermanentStepError);
  });
});

describe('placeholder media values (made by the one generator)', () => {
  const NONE: DatabaseHandOver = {
    has: () => Promise.resolve(false),
    store: () => Promise.reject(new Error('not reached')),
    read: () => Promise.resolve(undefined),
    discard: () => Promise.resolve(),
  };
  const BASE: TenantEntryInputs = {
    secrets: () =>
      Promise.resolve({
        template: `${MEDIA_PLACEHOLDER_NAMES.map((n) => `${n}=`).join('\n')}\n`,
        values: {},
      }),
    stack: () => Promise.reject(new Error('not reached')),
    deployKey: () => Promise.reject(new Error('not reached')),
  };
  const request: StepRequest = {
    key: 'k',
    id: 'render-host-secrets',
    idempotencyKey: 'k@d',
    inputs: { slot: SLOT },
  };
  const made = async (): Promise<Readonly<Record<string, string>>> =>
    (await new GeneratedTenantEntryInputs(BASE, NONE).secrets(request)).values;

  it('are random, marked, one for each named secret', async () => {
    expect([...PLACEHOLDER_KEYS]).toEqual([...MEDIA_PLACEHOLDER_NAMES]);
    const a = await made();
    const b = await made();
    expect(Object.keys(a)).toEqual([...MEDIA_PLACEHOLDER_NAMES]);
    for (const [name, value] of Object.entries(a)) {
      expect(value.startsWith(PLACEHOLDER_PREFIX)).toBe(true);
      expect(isPlaceholder(value)).toBe(true);
      expect(value).not.toBe(b[name]);
    }
    expect(isPlaceholder('AKIA-REAL')).toBe(false);
  });
});
