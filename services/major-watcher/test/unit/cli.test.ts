import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { CLI_ENV_VARS } from '../../src/env.js';

// Exercises main() directly -- the exact function the built dist/cli.js
// invokes, not a parallel reimplementation of its logic. Review cycle 1's
// finding: the "not yet deployed" and "hard error" states were only ever
// a console line, invisible next to an ordinary "nothing to send" green
// run unless someone opens the raw Actions log. Every scenario below
// checks both the GitHub annotation prefix on stdout/stderr and the
// $GITHUB_STEP_SUMMARY file content, not just the return code.

const GITHUB_RELEASES_URL = 'api.github.com';

function fetchStub(githubBody: unknown, ntfyOk = true) {
  return vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.includes(GITHUB_RELEASES_URL)) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => githubBody } as Response;
    }
    return {
      ok: ntfyOk,
      status: ntfyOk ? 200 : 500,
      statusText: ntfyOk ? 'OK' : 'Internal Server Error',
    } as Response;
  });
}

describe('main (the real CLI entry point)', () => {
  let dir: string;
  let statePath: string;
  let summaryPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'major-watcher-cli-'));
    statePath = join(dir, 'state.json');
    summaryPath = join(dir, 'summary.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('missing state path: ::error:: annotation, a summary line, exit 2', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const env = { GITHUB_STEP_SUMMARY: summaryPath };

    const code = await main(env, log, error);

    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^::error::.*MAJOR_WATCHER_STATE_PATH/)
    );
    expect(await readFile(summaryPath, 'utf8')).toMatch(
      /^:x: major-watcher failed:.*MAJOR_WATCHER_STATE_PATH/
    );
  });

  it('missing NTFY_URL: ::warning:: annotation, a summary line, exit 0, nothing published', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 6 }));
    const log = vi.fn();
    const error = vi.fn();
    const fetchImpl = fetchStub([]);
    vi.stubGlobal('fetch', fetchImpl);
    const env = { [CLI_ENV_VARS.STATE_PATH]: statePath, GITHUB_STEP_SUMMARY: summaryPath };

    const code = await main(env, log, error);

    expect(code).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^::warning::.*NOT paging anyone/));
    expect(await readFile(summaryPath, 'utf8')).toMatch(/^:warning:.*NOT paging anyone/);
    // No network call at all -- the ntfy-not-configured path returns before
    // ever touching the GitHub API, which is itself part of what makes the
    // no-op cheap and safe to run every 6 hours indefinitely.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('hard error (corrupt/missing state, NTFY_URL set): ::error:: annotation, a summary line, exit 1', async () => {
    // statePath deliberately never written -- readState()'s own refusal
    // (test/unit/state.test.ts) is what throws here.
    const log = vi.fn();
    const error = vi.fn();
    const env = {
      [CLI_ENV_VARS.STATE_PATH]: statePath,
      [CLI_ENV_VARS.NTFY_URL]: 'https://ntfy.example/topic',
      GITHUB_STEP_SUMMARY: summaryPath,
    };

    const code = await main(env, log, error);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^::error::.*no dedupe state/));
    expect(await readFile(summaryPath, 'utf8')).toMatch(
      /^:x: major-watcher failed:.*no dedupe state/
    );
  });

  it('happy path, a new major: notifies, logs plainly (no annotation), a Paged summary line, exit 0', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const log = vi.fn();
    const error = vi.fn();
    const fetchImpl = fetchStub([
      { tag_name: 'v6.0.0-alpha.1', published_at: '2025-07-16T10:54:47Z', draft: false },
    ]);
    vi.stubGlobal('fetch', fetchImpl);
    const env = {
      [CLI_ENV_VARS.STATE_PATH]: statePath,
      [CLI_ENV_VARS.NTFY_URL]: 'https://ntfy.example/topic',
      GITHUB_STEP_SUMMARY: summaryPath,
    };

    const code = await main(env, log, error);

    expect(code).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^notified: new major line 6/));
    expect(await readFile(summaryPath, 'utf8')).toMatch(/^Paged: Ghost major line 6 announced\.$/m);
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      lastNotifiedMajor: number;
    };
    expect(persisted.lastNotifiedMajor).toBe(6);
  });

  it('happy path, nothing new: plain log, no annotation, no summary write, exit 0', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 6 }));
    const log = vi.fn();
    const error = vi.fn();
    const fetchImpl = fetchStub([
      { tag_name: 'v6.65.0', published_at: '2026-09-22T15:28:40Z', draft: false },
    ]);
    vi.stubGlobal('fetch', fetchImpl);
    const env = {
      [CLI_ENV_VARS.STATE_PATH]: statePath,
      [CLI_ENV_VARS.NTFY_URL]: 'https://ntfy.example/topic',
      GITHUB_STEP_SUMMARY: summaryPath,
    };

    const code = await main(env, log, error);

    expect(code).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^no new major line above 6/));
    await expect(readFile(summaryPath, 'utf8')).rejects.toThrow();
  });

  it('appendStepSummary is a no-op with no GITHUB_STEP_SUMMARY set (a bare local run)', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 6 }));
    const log = vi.fn();
    const error = vi.fn();
    const fetchImpl = fetchStub([]);
    vi.stubGlobal('fetch', fetchImpl);

    const code = await main({ [CLI_ENV_VARS.STATE_PATH]: statePath }, log, error);

    expect(code).toBe(0);
    // No throw from the missing-summary-path branch is the assertion here.
  });

  it('defaults env/log/error to process.env and console when not injected', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const originalEnv = process.env[CLI_ENV_VARS.STATE_PATH];
    delete process.env[CLI_ENV_VARS.STATE_PATH];
    try {
      const code = await main();
      expect(code).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^::error::/));
    } finally {
      if (originalEnv === undefined) delete process.env[CLI_ENV_VARS.STATE_PATH];
      else process.env[CLI_ENV_VARS.STATE_PATH] = originalEnv;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
