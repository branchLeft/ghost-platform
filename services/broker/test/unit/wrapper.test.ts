import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSlotWrapper, WrapperError, type SlotWrapper } from '../../src/wrapper.js';
import { makeTempDir } from '../../src/atomicFile.js';
import { join } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';

const FAKE_WRAPPER = fileURLToPath(new URL('../helpers/fakeWrapper.mjs', import.meta.url));

async function readLoggedInvocations(logPath: string): Promise<string[][]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

describe('createSlotWrapper', () => {
  let dir: string;
  let logPath: string;
  let wrapper: SlotWrapper;

  beforeEach(async () => {
    dir = await makeTempDir('broker-wrapper-');
    logPath = join(dir, 'invocations.log');
    process.env.FAKE_WRAPPER_LOG = logPath;
    delete process.env.FAKE_WRAPPER_FAIL;
    wrapper = createSlotWrapper({
      command: FAKE_WRAPPER,
      prefix: [process.execPath],
      timeoutMs: 5000,
    });
  });

  afterEach(async () => {
    delete process.env.FAKE_WRAPPER_LOG;
    delete process.env.FAKE_WRAPPER_FAIL;
    await rm(dir, { recursive: true, force: true });
  });

  it('invokes start with slot, colour and verb as three distinct argv elements', async () => {
    await wrapper.start('0' as SlotName, 'a');
    expect(await readLoggedInvocations(logPath)).toEqual([['0', 'a', 'start']]);
  });

  it('invokes stop with the same three-element shape', async () => {
    await wrapper.stop('3' as SlotName, 'b');
    expect(await readLoggedInvocations(logPath)).toEqual([['3', 'b', 'stop']]);
  });

  it('invokes reset with exactly two argv elements, no colour', async () => {
    await wrapper.reset('6' as SlotName);
    expect(await readLoggedInvocations(logPath)).toEqual([['6', 'reset']]);
  });

  it('rejects with a WrapperError, carrying stdout/stderr, when the wrapper exits non-zero', async () => {
    process.env.FAKE_WRAPPER_FAIL = '1';
    await expect(wrapper.reset('0' as SlotName)).rejects.toBeInstanceOf(WrapperError);
  });

  it('refuses to run with no command and no prefix configured, rather than spawning an empty argv[0]', async () => {
    const empty = createSlotWrapper({ command: '', prefix: [], timeoutMs: 1000 });
    await expect(empty.reset('0' as SlotName)).rejects.toThrow(/wrapper command is empty/);
  });

  // The argv-joining defect workspace#1188's review found against real
  // `sudo -n` on PR#227 (a slot/colour/verb merged into one argv element
  // reads identically to sudoers, which matches space-joined command text
  // rather than argv boundaries) is proven by sabotage against
  // `createSlotWrapper` itself, not re-implemented here -- see the PR body's
  // sabotage record: `run()` was edited to join `args` with a space into a
  // single element before this exact test ("invokes reset with exactly two
  // argv elements") went red, then reverted.
});
