import { appendFile } from 'node:fs/promises';
import { run } from './check.js';
import { CLI_ENV_VARS } from './env.js';

// Process wiring -- but unlike a typical thin CLI shim, main() itself is
// exercised directly by test/unit/cli.test.ts, through this exact
// function, not a reimplementation of it. What it must not do is fail
// silently: a missing NTFY_URL and a hard runtime error both write a
// GitHub Actions annotation (`::warning::` / `::error::`) and a
// $GITHUB_STEP_SUMMARY line, on top of the ordinary console output, so
// neither state is visible only to someone who happens to open the run's
// raw log. Silent-and-green was already this estate's own failure class
// (see README.md "Owed").

async function appendStepSummary(env: typeof process.env, markdown: string): Promise<void> {
  const path = env.GITHUB_STEP_SUMMARY;
  // Unset outside Actions -- a bare `node dist/cli.js`, or a test that
  // never set it. Not an error: the summary is additive visibility, not
  // the primary output.
  if (!path) return;
  await appendFile(path, `${markdown}\n`, 'utf8');
}

export async function main(
  env: typeof process.env = process.env,
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error
): Promise<number> {
  const statePath = env[CLI_ENV_VARS.STATE_PATH];
  if (!statePath) {
    const msg = `missing required env var ${CLI_ENV_VARS.STATE_PATH}`;
    error(`::error::${msg}`);
    await appendStepSummary(env, `:x: major-watcher failed: ${msg}`);
    return 2;
  }

  const ntfyUrl = env[CLI_ENV_VARS.NTFY_URL];

  if (!ntfyUrl) {
    const msg =
      'NTFY_URL is not set -- self-hosted ntfy is not deployed yet (see README.md "Owed"). This run is NOT paging anyone.';
    log(`::warning::${msg}`);
    await appendStepSummary(env, `:warning: ${msg}`);
    return 0;
  }

  try {
    const result = await run({
      statePath,
      ntfy: { url: ntfyUrl, token: env[CLI_ENV_VARS.NTFY_TOKEN] },
      githubToken: env[CLI_ENV_VARS.GITHUB_TOKEN],
    });
    if (result.notified) {
      log(
        `notified: new major line ${result.state.lastNotifiedMajor} -- state updated at ${statePath}`
      );
      await appendStepSummary(
        env,
        `Paged: Ghost major line ${result.state.lastNotifiedMajor} announced.`
      );
    } else {
      log(`no new major line above ${result.state.lastNotifiedMajor}; nothing sent`);
    }
    return 0;
  } catch (err) {
    const msg = String(err instanceof Error ? err.stack : err);
    error(`::error::${msg}`);
    await appendStepSummary(env, `:x: major-watcher failed: ${msg}`);
    return 1;
  }
}

/* v8 ignore start -- the process entrypoint guard itself; main() above is what test/unit/cli.test.ts exercises */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
/* v8 ignore stop */
