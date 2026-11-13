import { describe, expect, it } from 'vitest';
import { RunConfigError, parseRunConfig } from '../../src/index.js';

const GOOD = {
  stateFile: '/STATE_DIR_PLACEHOLDER/state.jsonl',
  approvalsFile: '/FILES_PLACEHOLDER/approvals.json',
  registerFile: '/FILES_PLACEHOLDER/register.json',
  hosts: { 'db-host': { argv: ['/PROGRAM_PLACEHOLDER', 'arg-one'], timeoutMs: 5000 } },
  retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
  reportTimeoutMs: 500,
};

const problemsOf = (value: unknown): readonly string[] => {
  try {
    parseRunConfig(value);
  } catch (e) {
    if (e instanceof RunConfigError) return e.problems;
    throw e;
  }
  return [];
};

describe('parseRunConfig', () => {
  it('accepts a full configuration and returns it typed', () => {
    expect(parseRunConfig(GOOD)).toEqual(GOOD);
  });

  it('accepts a configuration with no hosts and no optional settings', () => {
    const { stateFile, approvalsFile, registerFile } = GOOD;
    expect(parseRunConfig({ stateFile, approvalsFile, registerFile, hosts: {} })).toEqual({
      stateFile,
      approvalsFile,
      registerFile,
      hosts: {},
    });
  });

  it('refuses a value that is not an object', () => {
    expect(problemsOf([])).toEqual(['the configuration is not an object']);
    expect(problemsOf(null)).toEqual(['the configuration is not an object']);
  });

  it('refuses a key it does not know, naming it', () => {
    expect(problemsOf({ ...GOOD, statefile: '/X' })).toContain('unknown keys: statefile');
  });

  it.each(['stateFile', 'approvalsFile', 'registerFile'])('refuses a relative %s', (field) => {
    expect(problemsOf({ ...GOOD, [field]: 'relative/path' })).toContain(
      `${field} is not an absolute path`
    );
  });

  it('refuses a host that is not an entry point', () => {
    expect(problemsOf({ ...GOOD, hosts: { shell: GOOD.hosts['db-host'] } })).toContain(
      'hosts.shell is not an entry point'
    );
  });

  it('refuses a program that is looked up on the path instead of named absolutely', () => {
    expect(problemsOf({ ...GOOD, hosts: { edge: { argv: ['ssh', 'host'] } } })).toContain(
      'hosts.edge.argv[0] is not an absolute path'
    );
  });

  it('refuses an empty argument list, an empty argument and a non-object spec', () => {
    expect(problemsOf({ ...GOOD, hosts: { edge: { argv: [] } } })).toContain(
      'hosts.edge.argv is not a list of non-empty text'
    );
    expect(problemsOf({ ...GOOD, hosts: { edge: { argv: ['/P', ''] } } })).toContain(
      'hosts.edge.argv is not a list of non-empty text'
    );
    expect(problemsOf({ ...GOOD, hosts: { edge: 'ssh host' } })).toContain(
      'hosts.edge is not an object'
    );
    expect(problemsOf({ ...GOOD, hosts: 'ssh host' })).toContain('hosts is not an object');
  });

  it('refuses unknown keys in a host spec and a timeout out of range', () => {
    expect(problemsOf({ ...GOOD, hosts: { edge: { argv: ['/P'], shell: true } } })).toContain(
      'hosts.edge has unknown keys: shell'
    );
    expect(problemsOf({ ...GOOD, hosts: { edge: { argv: ['/P'], timeoutMs: 0 } } })).toEqual([
      'hosts.edge.timeoutMs is not a whole number of milliseconds up to 3600000',
    ]);
  });

  it('refuses a retry policy that is not exactly three whole numbers, and a bad report timeout', () => {
    expect(problemsOf({ ...GOOD, retry: { maxAttempts: 3 } })).toContain(
      'retry needs exactly maxAttempts, baseDelayMs and maxDelayMs, whole numbers'
    );
    expect(problemsOf({ ...GOOD, reportTimeoutMs: 1.5 })).toContain(
      'reportTimeoutMs is not a whole number'
    );
  });

  it('lists every problem at once', () => {
    expect(problemsOf({ hosts: 1 }).length).toBeGreaterThanOrEqual(4);
  });
});
