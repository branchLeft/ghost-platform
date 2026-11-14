import { chmod, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, STEP_IDS, runCli, type Env, type RunResult } from '../../src/index.js';
import { APPROVAL } from '../support/doubles.js';
import { Workdir } from '../support/workdir.js';

let work: Workdir;
beforeEach(async () => {
  work = await Workdir.create();
});
afterEach(async () => {
  await work.remove();
});

interface Outcome {
  readonly code: number;
  readonly stdout: string[];
  readonly stderr: string[];
}

async function run(
  args: readonly string[],
  env: Env = { PATH: process.env['PATH'] }
): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
    env,
  });
  return { code, stdout, stderr };
}

const runApproval = async (
  config: string,
  id: string = APPROVAL.approvalId,
  env?: Env
): Promise<Outcome> => run(['--config', config, '--approval-id', id], env);

const events = (o: Outcome): { type: string; key?: string }[] =>
  o.stderr.filter((l) => l.startsWith('{"type"')).map((l) => JSON.parse(l) as { type: string });

describe('runCli: the approval alone takes a tenant from approved to done', () => {
  it('runs all thirteen steps, once each, in dependency order, on the one approval id', async () => {
    const config = await work.deployment();
    const outcome = await runApproval(config);

    expect(outcome.code).toBe(EXIT.complete);
    expect(outcome.stdout).toHaveLength(1);
    const result = JSON.parse(outcome.stdout[0] ?? '') as RunResult;
    expect(result.status).toBe('complete');
    expect(result.ran).toHaveLength(STEP_IDS.length);
    expect(result.skipped).toEqual([]);

    const called = await work.calledIds();
    expect([...called].sort()).toEqual([...STEP_IDS].sort());
    expect(called.indexOf('confirm-register-assignment')).toBe(0);
    expect(called.indexOf('first-deploy')).toBeGreaterThan(called.indexOf('publish-mail-dns'));

    const types = events(outcome).map((e) => e.type);
    expect(types[0]).toBe('run-started');
    expect(types.at(-1)).toBe('run-complete');
    const state = await readFile(work.path('state.jsonl'), 'utf8');
    expect(state.trim().split('\n').at(-1)).toContain('"event":"run-complete"');
  });

  it('starts host programs without the controller’s own tokens', async () => {
    const config = await work.deployment();
    await work.modes({ 'confirm-register-assignment': 'env' });
    const env = {
      PATH: process.env['PATH'],
      GH_TOKEN: 'TOKEN_PLACEHOLDER',
      HOME: '/HOME_PLACEHOLDER',
    };
    expect((await runApproval(config, APPROVAL.approvalId, env)).code).toBe(EXIT.complete);
    const names = JSON.parse(await readFile(work.path('env.json'), 'utf8')) as string[];
    expect(names).toContain('HOME');
    expect(names).not.toContain('GH_TOKEN');
  });

  it('writes the state file private to the user', async () => {
    await runApproval(await work.deployment());
    const { stat } = await import('node:fs/promises');
    expect((await stat(work.path('state.jsonl'))).mode & 0o077).toBe(0);
  });
});

describe('runCli: a run that stops resumes without repeating what is done', () => {
  it('stops at the failing step, then a second call finishes and runs nothing twice', async () => {
    const config = await work.deployment();
    await work.modes({ 'create-database': 'fail' });
    const first = await runApproval(config);

    expect(first.code).toBe(EXIT.stopped);
    const stopped = JSON.parse(first.stdout[0] ?? '') as RunResult;
    expect(stopped.stoppedAt?.reason).toBe('step-failed');
    expect(stopped.stoppedAt?.key).toBe(`${APPROVAL.tenantId}/create-database`);
    // Two attempts at the failing step (the configured retry), none after it.
    expect((await work.calledIds()).filter((id) => id === 'create-database')).toHaveLength(2);
    expect(await work.calledIds()).not.toContain('render-host-secrets');

    await work.modes({});
    const second = await runApproval(config);
    expect(second.code).toBe(EXIT.complete);
    const resumed = JSON.parse(second.stdout[0] ?? '') as RunResult;
    expect(resumed.skipped).toEqual(stopped.ran);
    expect(resumed.ran.length + resumed.skipped.length).toBe(STEP_IDS.length);

    const counts = new Map<string, number>();
    for (const id of await work.calledIds()) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const id of STEP_IDS) {
      expect(counts.get(id), id).toBe(id === 'create-database' ? 3 : 1);
    }
  });

  it('stops at a step whose entry point is not configured, and acts on nothing after it', async () => {
    const config = await work.deployment();
    const { readFile: read, writeFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await read(config, 'utf8')) as { hosts: Record<string, unknown> };
    delete parsed.hosts['edge'];
    await writeFile(config, JSON.stringify(parsed));

    const outcome = await runApproval(config);
    expect(outcome.code).toBe(EXIT.stopped);
    const state = await readFile(work.path('state.jsonl'), 'utf8');
    expect(state).toContain('no host entry point is configured for edge');
    const called = await work.calledIds();
    expect(called).not.toContain('publish-hostnames');
    expect(called).not.toContain('first-deploy');
  });

  it('keeps what a host prints out of the state file, the console and the error', async () => {
    const config = await work.deployment();
    await work.modes({ 'create-database': 'noisy' });
    const outcome = await runApproval(config);
    const everything = [
      ...outcome.stdout,
      ...outcome.stderr,
      await readFile(work.path('state.jsonl'), 'utf8'),
    ].join('\n');
    expect(everything).not.toContain('SECRETVALUE');
  });
});

describe('runCli: without a recorded approval nothing runs', () => {
  it('refuses an id the ledger does not hold, records the halt and calls no host', async () => {
    const config = await work.deployment();
    await work.json('approvals.json', { approvals: [] });
    const outcome = await runApproval(config);

    expect(outcome.code).toBe(EXIT.refused);
    expect(await work.calledIds()).toEqual([]);
    expect(await readFile(work.path('state.jsonl'), 'utf8')).toContain('"event":"run-halted"');
    expect(outcome.stderr.at(-1)).toContain('ApprovalRequiredError');
  });

  it('refuses an approval that does not cover every scope', async () => {
    const config = await work.deployment();
    await work.json('approvals.json', { approvals: [{ ...APPROVAL, scopes: ['setup'] }] });
    const outcome = await runApproval(config);
    expect(outcome.code).toBe(EXIT.refused);
    expect(outcome.stderr.at(-1)).toContain('ApprovalScopeError');
    expect(await work.calledIds()).toEqual([]);
  });

  it('refuses an approvals file other users can write, and calls no host', async () => {
    const config = await work.deployment();
    await chmod(work.path('approvals.json'), 0o666);
    const outcome = await runApproval(config);
    expect(outcome.code).toBe(EXIT.failed);
    expect(outcome.stderr.at(-1)).toContain('other users can write it');
    expect(await work.calledIds()).toEqual([]);
  });

  it('refuses a register file other users can write, and calls no host', async () => {
    const config = await work.deployment();
    await chmod(work.path('register.json'), 0o666);
    const outcome = await runApproval(config);
    expect(outcome.code).toBe(EXIT.failed);
    expect(await work.calledIds()).toEqual([]);
  });

  it('refuses a bad retry policy before any step', async () => {
    const config = await work.deployment({
      retry: { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const outcome = await runApproval(config);
    expect(outcome.code).toBe(EXIT.failed);
    expect(await work.calledIds()).toEqual([]);
  });
});

describe('runCli: bad input is refused before anything is read or run', () => {
  it.each([
    ['no arguments', []],
    ['no approval id', ['--config', '/C_PLACEHOLDER']],
    ['no config', ['--approval-id', 'ID_PLACEHOLDER']],
    ['an unknown flag', ['--config', '/C', '--approval-id', 'ID', '--force']],
    ['a positional', ['--config', '/C', '--approval-id', 'ID', 'extra']],
    ['an approval id that is a path', ['--config', '/C', '--approval-id', '../ID']],
    ['an approval id with a space', ['--config', '/C', '--approval-id', 'a b']],
  ])('exits with the usage status on %s', async (_name, args) => {
    const outcome = await run(args);
    expect(outcome.code).toBe(EXIT.usage);
    expect(outcome.stderr).toHaveLength(1);
    expect(outcome.stdout).toEqual([]);
  });

  it('exits with the usage status on a configuration that cannot be read or is invalid', async () => {
    const missing = await runApproval(work.path('missing.json'));
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr[0]).toContain('TrustedFileError');

    const invalid = await work.json('bad.json', { stateFile: 'relative' });
    const outcome = await runApproval(invalid);
    expect(outcome.code).toBe(EXIT.usage);
    expect(outcome.stderr[0]).toContain('RunConfigError');
  });
});
