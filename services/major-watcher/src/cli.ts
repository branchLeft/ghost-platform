import { run } from './check.js';

// Thin process wiring only -- see check.ts for the actual logic this
// calls, which is what test/unit exercises directly.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env var ${name}`);
    process.exit(2);
  }
  return value;
}

const statePath = requireEnv('MAJOR_WATCHER_STATE_PATH');
const ntfyUrl = process.env.NTFY_URL;
const ntfyToken = process.env.NTFY_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;

// NTFY_URL absent means the self-hosted receiver is not deployed yet (see
// README.md "Owed") -- an expected, temporary state while that is set up,
// not a fault in this watcher. Exiting 0 here keeps the scheduled run from
// going red every 6 hours for as long as that step is outstanding; a red
// run is reserved for something actually wrong (an unreachable GitHub API,
// a corrupt state file, or -- once NTFY_URL exists -- ntfy itself
// rejecting the publish, all of which still throw and exit 1 below).
if (!ntfyUrl) {
  console.log(
    'NTFY_URL is not set -- self-hosted ntfy is not deployed yet (see README.md "Owed"). Nothing to do.'
  );
  process.exit(0);
}

try {
  const result = await run({
    statePath,
    ntfy: { url: ntfyUrl, token: ntfyToken },
    githubToken,
  });
  if (result.notified) {
    console.log(
      `notified: new major line ${result.state.lastNotifiedMajor} -- state updated at ${statePath}`
    );
  } else {
    console.log(`no new major line above ${result.state.lastNotifiedMajor}; nothing sent`);
  }
} catch (err) {
  console.error(String(err instanceof Error ? err.stack : err));
  process.exit(1);
}
