// The exact environment variable names src/cli.ts reads, named once here
// so a test can check the scheduled workflow's own `env:` block against
// this list rather than against a second, hand-copied list that can drift
// from it silently -- a workflow env-var typo would otherwise convert
// every future run into a no-op indistinguishable from ntfy not being
// deployed yet, and nothing would catch it (see
// test/unit/workflowWiring.test.ts).
export const CLI_ENV_VARS = {
  STATE_PATH: 'MAJOR_WATCHER_STATE_PATH',
  NTFY_URL: 'NTFY_URL',
  NTFY_TOKEN: 'NTFY_TOKEN',
  GITHUB_TOKEN: 'GITHUB_TOKEN',
} as const;
