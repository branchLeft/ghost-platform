import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CLI_ENV_VARS } from '../../src/env.js';

// Review cycle 1's sabotage: renaming NTFY_URL to NTFY_URLL in the
// workflow file only left every existing check green -- typecheck,
// coverage and build all only ever see src/, never the workflow YAML that
// actually invokes it. This is the check that closes that gap: it parses
// the real workflow file on disk and asserts its "Run the watcher" step
// sets exactly the env var names src/env.ts's CLI_ENV_VARS names, neither
// more nor fewer, so a rename on either side fails here rather than
// silently turning every future scheduled run into a no-op indistinguishable
// from ntfy not being deployed.

interface WorkflowStep {
  readonly name?: string;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly steps: readonly WorkflowStep[];
}

interface WorkflowFile {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

async function loadRunWorkflow(): Promise<WorkflowFile> {
  // Four levels up from test/unit/ is the repo root (services/major-watcher/test/unit -> services/major-watcher -> services -> repo root).
  const path = fileURLToPath(
    new URL('../../../../.github/workflows/major-watcher-run.yml', import.meta.url)
  );
  return parse(await readFile(path, 'utf8')) as WorkflowFile;
}

describe('major-watcher-run.yml wiring', () => {
  it('passes the watcher step exactly the env var names src/cli.ts reads via CLI_ENV_VARS', async () => {
    const workflow = await loadRunWorkflow();
    const steps = workflow.jobs.watch?.steps ?? [];
    const runStep = steps.find((s) => s.name === 'Run the watcher');

    expect(runStep, 'expected a "Run the watcher" step in the watch job').toBeDefined();
    expect(
      runStep?.env,
      'expected the "Run the watcher" step to declare an env: block'
    ).toBeDefined();

    const workflowVarNames = new Set(Object.keys(runStep?.env ?? {}));
    const sourceVarNames = new Set(Object.values(CLI_ENV_VARS));

    expect(workflowVarNames).toEqual(sourceVarNames);
  });

  it("points MAJOR_WATCHER_STATE_PATH at the state step's own output, not a literal path", async () => {
    const workflow = await loadRunWorkflow();
    const steps = workflow.jobs.watch?.steps ?? [];
    const runStep = steps.find((s) => s.name === 'Run the watcher');
    const value = String(runStep?.env?.[CLI_ENV_VARS.STATE_PATH] ?? '');
    expect(value).toContain('steps.state.outputs.path');
  });
});
