import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSlotWrapper,
  DetachReceiptError,
  WrapperError,
  type SlotWrapper,
} from '../../src/wrapper.js';
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

  it('invokes load with exactly two argv elements -- the literal verb and the path, never joined', async () => {
    await wrapper.load('/var/lib/branchleft-broker/image-tmp/image.tar');
    expect(await readLoggedInvocations(logPath)).toEqual([
      ['load', '/var/lib/branchleft-broker/image-tmp/image.tar'],
    ]);
  });

  it("resolves load with the wrapper process's own stdout, unlike start/stop/reset", async () => {
    process.env.FAKE_WRAPPER_LOAD_OUTPUT = `Loaded image ID: sha256:${'1'.repeat(64)}\n`;
    const stdout = await wrapper.load('/var/lib/branchleft-broker/image-tmp/image.tar');
    expect(stdout).toBe(`Loaded image ID: sha256:${'1'.repeat(64)}\n`);
    delete process.env.FAKE_WRAPPER_LOAD_OUTPUT;
  });

  it('rejects with a WrapperError, carrying stdout/stderr, when the wrapper exits non-zero', async () => {
    process.env.FAKE_WRAPPER_FAIL = '1';
    await expect(wrapper.reset('0' as SlotName)).rejects.toBeInstanceOf(WrapperError);
  });

  it('rejects with a WrapperError when the wrapper runs longer than timeoutMs', async () => {
    const slow = createSlotWrapper({
      command: FAKE_WRAPPER,
      prefix: [process.execPath],
      timeoutMs: 200,
    });
    process.env.FAKE_WRAPPER_SLEEP_MS = '3000';
    try {
      await expect(slow.reset('0' as SlotName)).rejects.toBeInstanceOf(WrapperError);
    } finally {
      delete process.env.FAKE_WRAPPER_SLEEP_MS;
    }
  });

  it('refuses to run with no command and no prefix configured, rather than spawning an empty argv[0]', async () => {
    const empty = createSlotWrapper({ command: '', prefix: [], timeoutMs: 1000 });
    await expect(empty.reset('0' as SlotName)).rejects.toThrow(/wrapper command is empty/);
  });

  it('invokes detach with exactly two argv elements, the slot and the literal verb', async () => {
    await wrapper.detach('2' as SlotName);
    expect(await readLoggedInvocations(logPath)).toEqual([['2', 'detach']]);
  });

  it('resolves detach with the receipt the wrapper printed', async () => {
    const receipt = await wrapper.detach('2' as SlotName);
    expect(receipt).toEqual({ entry: '2-1', sha256: 'a'.repeat(64), bytes: 4096 });
  });

  it.each([
    ['nothing', ''],
    ['prose', 'detached ok\n'],
    ['two lines', `${JSON.stringify({ entry: '2-1', sha256: 'a'.repeat(64), bytes: 1 })}\n{}\n`],
    ['an extra field', JSON.stringify({ entry: '2-1', sha256: 'a'.repeat(64), bytes: 1, x: 1 })],
    ['an upper-case digest', JSON.stringify({ entry: '2-1', sha256: 'A'.repeat(64), bytes: 1 })],
    ['a partial entry', JSON.stringify({ entry: '2-1.partial', sha256: 'a'.repeat(64), bytes: 1 })],
    ['a path as the entry', JSON.stringify({ entry: '../2-1', sha256: 'a'.repeat(64), bytes: 1 })],
    ['a string byte count', JSON.stringify({ entry: '2-1', sha256: 'a'.repeat(64), bytes: '1' })],
  ])('rejects a detach that printed %s as its receipt', async (_name, output) => {
    process.env.FAKE_WRAPPER_DETACH_OUTPUT = output;
    try {
      await expect(wrapper.detach('2' as SlotName)).rejects.toBeInstanceOf(DetachReceiptError);
    } finally {
      delete process.env.FAKE_WRAPPER_DETACH_OUTPUT;
    }
  });

  it('bounds detach by its own timeout, not the one the other verbs use', async () => {
    const config = {
      command: FAKE_WRAPPER,
      prefix: [process.execPath],
      timeoutMs: 100,
      detachTimeoutMs: 5000,
    };
    process.env.FAKE_WRAPPER_SLEEP_MS = '600';
    try {
      const slow = createSlotWrapper(config);
      await expect(slow.reset('0' as SlotName)).rejects.toBeInstanceOf(WrapperError);
      await expect(slow.detach('0' as SlotName)).resolves.toMatchObject({ entry: '0-1' });
    } finally {
      delete process.env.FAKE_WRAPPER_SLEEP_MS;
    }
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
