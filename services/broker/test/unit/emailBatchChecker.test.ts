import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import {
  createFailClosedEmailBatchChecker,
  createSudoEmailBatchChecker,
  type EmailBatchChecker,
} from '../../src/emailBatchChecker.js';

const FAKE_WRAPPER = fileURLToPath(new URL('../helpers/fakeWrapper.mjs', import.meta.url));

async function readLoggedInvocations(logPath: string): Promise<string[][]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

describe('createFailClosedEmailBatchChecker', () => {
  it('always reports a submitting batch -- the safe default when no real checker is configured', async () => {
    const checker = createFailClosedEmailBatchChecker();
    expect(await checker.hasSubmittingBatch('0' as SlotName)).toBe(true);
    expect(await checker.hasSubmittingBatch('6' as SlotName)).toBe(true);
  });
});

describe('createSudoEmailBatchChecker', () => {
  let checker: EmailBatchChecker;
  const loggedLines: string[] = [];

  beforeEach(() => {
    delete process.env.FAKE_WRAPPER_FAIL;
    delete process.env.FAKE_WRAPPER_STDOUT;
    delete process.env.FAKE_WRAPPER_SLEEP_MS;
    loggedLines.length = 0;
    checker = createSudoEmailBatchChecker(
      { command: FAKE_WRAPPER, prefix: [process.execPath], timeoutMs: 5000 },
      (line) => loggedLines.push(line)
    );
  });

  afterEach(() => {
    delete process.env.FAKE_WRAPPER_FAIL;
    delete process.env.FAKE_WRAPPER_STDOUT;
    delete process.env.FAKE_WRAPPER_SLEEP_MS;
  });

  it('reports no submitting batch when the wrapper prints a bare zero', async () => {
    process.env.FAKE_WRAPPER_STDOUT = '0\n';
    expect(await checker.hasSubmittingBatch('0' as SlotName)).toBe(false);
  });

  it('reports a submitting batch when the wrapper prints a positive count', async () => {
    process.env.FAKE_WRAPPER_STDOUT = '3\n';
    expect(await checker.hasSubmittingBatch('0' as SlotName)).toBe(true);
  });

  it('fails closed when the wrapper exits non-zero', async () => {
    process.env.FAKE_WRAPPER_FAIL = '1';
    expect(await checker.hasSubmittingBatch('0' as SlotName)).toBe(true);
    expect(loggedLines.some((line) => line.includes('slot "0"'))).toBe(true);
  });

  it('fails closed when the wrapper is slower than timeoutMs, without waiting for it to finish', async () => {
    // Short durations deliberately -- this busy-waits a real subprocess
    // (see fakeWrapper.mjs's own doc comment), and vitest runs test files
    // in parallel: a multi-second CPU-bound wait here would starve
    // sibling files' own timing-sensitive tests, not just this one.
    process.env.FAKE_WRAPPER_SLEEP_MS = '300';
    const shortTimeoutChecker = createSudoEmailBatchChecker(
      { command: FAKE_WRAPPER, prefix: [process.execPath], timeoutMs: 30 },
      (line) => loggedLines.push(line)
    );
    const started = Date.now();
    const result = await shortTimeoutChecker.hasSubmittingBatch('0' as SlotName);
    const elapsedMs = Date.now() - started;
    expect(result).toBe(true);
    // Bounded well under the fake wrapper's own 300ms sleep -- proof
    // `timeoutMs` actually killed the slow subprocess rather than this
    // call simply finishing to wait for it.
    expect(elapsedMs).toBeLessThan(250);
  });

  it('fails closed when the wrapper prints something other than a bare count', async () => {
    process.env.FAKE_WRAPPER_STDOUT = 'not-a-count\n';
    expect(await checker.hasSubmittingBatch('0' as SlotName)).toBe(true);
  });

  it('fails closed on a negative-looking or decorated count rather than parsing a prefix of it', async () => {
    process.env.FAKE_WRAPPER_STDOUT = '3 rows\n';
    expect(await checker.hasSubmittingBatch('0' as SlotName)).toBe(true);
  });

  it('never rejects -- attemptStopOldColour awaits this directly inside its own refusal check', async () => {
    process.env.FAKE_WRAPPER_FAIL = '1';
    await expect(checker.hasSubmittingBatch('0' as SlotName)).resolves.toBe(true);
  });

  it('refuses to run with no command and no prefix configured, failing closed rather than spawning an empty argv[0]', async () => {
    const empty = createSudoEmailBatchChecker({ command: '', prefix: [], timeoutMs: 1000 });
    expect(await empty.hasSubmittingBatch('0' as SlotName)).toBe(true);
  });

  it('invokes the wrapper with slot, a fixed colour and "email-batches" as three distinct argv elements', async () => {
    const dir = await makeTempDir('broker-email-batch-checker-');
    const logPath = join(dir, 'invocations.log');
    process.env.FAKE_WRAPPER_LOG = logPath;
    process.env.FAKE_WRAPPER_STDOUT = '0\n';
    try {
      expect(await checker.hasSubmittingBatch('4' as SlotName)).toBe(false);
      expect(await readLoggedInvocations(logPath)).toEqual([['4', 'a', 'email-batches']]);
    } finally {
      delete process.env.FAKE_WRAPPER_LOG;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
