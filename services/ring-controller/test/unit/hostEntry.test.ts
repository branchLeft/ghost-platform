import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import {
  EXIT_CONFIG,
  EXIT_NOTHING_RUN,
  HOST_CREDENTIALS_DIR,
  HOST_KEY_NAME,
  HOST_PUBLIC_KEY_FILE,
  HOST_STATE_DIR,
  HostConfigError,
  UNWIRED_ADAPTERS,
  main,
  recorderEnvFromHost,
  runHostTick,
  startedAsScript,
} from '../../src/hostEntry.js';
import {
  ENV_HEAD_FILE,
  ENV_LOG_FILE,
  ENV_PUBLIC_KEY_FILE,
  ENV_SIGNING_KEY_FILE,
  type PromotionRecorder,
} from '../../src/promotionRecorder.js';
import { removeAll } from './helpers/chainFixtures.js';
import { makeKeyFiles } from './helpers/keyFiles.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await removeAll(dirs);
});

async function temp(): Promise<string> {
  const dir = await makeTempDir('ring-controller-host-entry-');
  dirs.push(dir);
  return dir;
}

/** The host's environment, as the role and the unit give it, under a throwaway root. */
function hostEnv(root: string, overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    [HOST_STATE_DIR]: join(root, 'state'),
    [HOST_KEY_NAME]: 'record-signing.pem',
    [HOST_CREDENTIALS_DIR]: join(root, 'creds'),
    [HOST_PUBLIC_KEY_FILE]: join(root, 'record-signing.pub'),
    ...overrides,
  };
  return env;
}

/** A recorder stand-in: the tests here never append, they only see what was opened. */
function fakeRecorder(): PromotionRecorder {
  return {
    record: async () => undefined,
    check: async () => null,
  };
}

/** The error a call throws, which must be a HostConfigError. */
function refusalOf(call: () => unknown): HostConfigError {
  try {
    call();
  } catch (error) {
    if (error instanceof HostConfigError) return error;
    throw error;
  }
  throw new Error('expected a HostConfigError, nothing was thrown');
}

function capture() {
  const lines: string[] = [];
  return { lines, report: (line: string) => lines.push(line) };
}

describe('recorderEnvFromHost', () => {
  it('maps the host inputs onto the four recorder variables', () => {
    const env = recorderEnvFromHost(hostEnv('/root'));
    expect(env).toEqual({
      [ENV_LOG_FILE]: '/root/state/promotion-record/promotion-chain.log',
      [ENV_HEAD_FILE]: '/root/state/promotion-record/promotion-head.json',
      [ENV_SIGNING_KEY_FILE]: '/root/creds/record-signing.pem',
      [ENV_PUBLIC_KEY_FILE]: '/root/record-signing.pub',
    });
  });

  it.each([HOST_STATE_DIR, HOST_CREDENTIALS_DIR, HOST_PUBLIC_KEY_FILE])(
    'refuses %s when it is unset, empty or relative, and names it',
    (name) => {
      for (const value of [undefined, '', 'relative/path']) {
        const error = refusalOf(() => recorderEnvFromHost(hostEnv('/root', { [name]: value })));
        expect(error.variable).toBe(name);
        expect(error.message).not.toContain('/root');
      }
    }
  );

  it.each(['', '../escape', 'a/b', '.hidden'])('refuses a key name %j', (name) => {
    expect(() => recorderEnvFromHost(hostEnv('/root', { [HOST_KEY_NAME]: name }))).toThrow(
      HostConfigError
    );
  });
});

describe('runHostTick', () => {
  it('refuses missing config with EXIT_CONFIG, names the input, and opens nothing', async () => {
    const openRecorder = vi.fn(async () => fakeRecorder());
    const { lines, report } = capture();
    const code = await runHostTick({
      env: hostEnv('/root', { [HOST_STATE_DIR]: undefined }),
      openRecorder,
      report,
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(openRecorder).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(HOST_STATE_DIR);
    expect(lines[0]).toContain('Nothing was run');
  });

  it('refuses a key or record the loader rejects, with EXIT_CONFIG and the refusal', async () => {
    const { lines, report } = capture();
    const code = await runHostTick({
      env: hostEnv('/root'),
      openRecorder: async () => {
        throw new Error('key file refused: missing ("/root/creds/record-signing.pem")');
      },
      report,
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(lines[0]).toContain('key file refused: missing');
  });

  it('hands the loader the mapped environment and the injected clock', async () => {
    const seen: { env?: Record<string, string>; now?: Date } = {};
    const fixed = new Date('2026-11-24T00:00:00Z');
    const { report } = capture();
    await runHostTick({
      env: hostEnv('/root'),
      openRecorder: async (env, now) => {
        seen.env = env;
        seen.now = now();
        return fakeRecorder();
      },
      now: () => fixed,
      report,
    });
    expect(seen.env?.[ENV_LOG_FILE]).toBe('/root/state/promotion-record/promotion-chain.log');
    expect(seen.now).toEqual(fixed);
  });

  it('exits EXIT_NOTHING_RUN, naming every adapter this build lacks, when the inputs are good', async () => {
    const { lines, report } = capture();
    const code = await runHostTick({
      env: hostEnv('/root'),
      openRecorder: async () => fakeRecorder(),
      report,
    });
    expect(code).toBe(EXIT_NOTHING_RUN);
    for (const adapter of UNWIRED_ADAPTERS) expect(lines[0]).toContain(adapter);
    expect(lines[0]).toContain('Nothing was run');
  });

  it('opens the real key and public half from the host layout and still runs nothing', async () => {
    const root = await temp();
    const creds = join(root, 'creds');
    await mkdir(creds);
    const keys = await makeKeyFiles(creds, 0o400);
    const { lines, report } = capture();
    const code = await runHostTick({
      env: hostEnv(root, {
        [HOST_KEY_NAME]: 'record-signing.pem',
        [HOST_CREDENTIALS_DIR]: creds,
        [HOST_PUBLIC_KEY_FILE]: keys.publicPath,
      }),
      report,
    });
    expect(code).toBe(EXIT_NOTHING_RUN);
    expect(lines[0]).toContain('no adapter');
  });

  it('refuses a real key name that is not there, with EXIT_CONFIG', async () => {
    const root = await temp();
    const creds = join(root, 'creds');
    await mkdir(creds);
    const keys = await makeKeyFiles(creds, 0o400);
    const { lines, report } = capture();
    const code = await runHostTick({
      env: hostEnv(root, {
        [HOST_KEY_NAME]: 'absent.pem',
        [HOST_CREDENTIALS_DIR]: creds,
        [HOST_PUBLIC_KEY_FILE]: keys.publicPath,
      }),
      report,
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(lines[0]).toContain('missing');
  });
});

describe('main', () => {
  it('sets the process exit code from one tick and writes the refusal to standard error', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const saved = process.exitCode;
    try {
      await main({ env: { [HOST_STATE_DIR]: '' } });
      expect(process.exitCode).toBe(EXIT_CONFIG);
      expect(write).toHaveBeenCalledWith(expect.stringContaining(HOST_STATE_DIR));
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('startedAsScript', () => {
  it('is false when node was started with no script, and true for this module as the script', () => {
    const self = join(process.cwd(), 'src', 'hostEntry.ts');
    expect(startedAsScript(undefined, 'file:///x/hostEntry.js')).toBe(false);
    expect(startedAsScript(self, `file://${self}`)).toBe(true);
  });

  it('runs the entry when the script cannot be resolved, so its refusal decides the exit code', () => {
    expect(startedAsScript('/nonexistent/entry.js', 'file:///nonexistent/hostEntry.js')).toBe(true);
  });
});
