import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSlotWrapper,
  DetachReceiptError,
  errorLogText,
  stderrOneLine,
  WrapperError,
  type SlotWrapper,
} from '../../src/wrapper.js';
import { makeTempDir } from '../../src/atomicFile.js';
import { join } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';

// Any C0 control character, DEL, or a Unicode line separator.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

const FAKE_WRAPPER = fileURLToPath(new URL('../helpers/fakeWrapper.mjs', import.meta.url));

async function readLoggedInvocations(logPath: string): Promise<string[][]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

describe('stderrOneLine', () => {
  it('trims the ends and escapes CR and LF so the text is one line', () => {
    expect(stderrOneLine('  first\r\nsecond\n')).toBe('first\\r\\nsecond');
  });

  it('is empty for stderr that is only whitespace', () => {
    expect(stderrOneLine(' \n\t')).toBe('');
  });

  it('escapes a lone CR', () => {
    expect(stderrOneLine('one\rtwo')).toBe('one\\rtwo');
  });

  it('escapes every other C0 control character, DEL and the Unicode line separators', () => {
    expect(stderrOneLine('a\u0000b\u001bc\u007fd\u0085e\u2028f\u2029g\th')).toBe(
      'a\\u0000b\\u001bc\\u007fd\\u0085e\\u2028f\\u2029g\\th'
    );
  });

  it('leaves no control character or line separator in its output', () => {
    const everyC0 = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join('x');
    expect(stderrOneLine(`x${everyC0}x\u0085\u2028\u2029x`)).not.toMatch(CONTROL_OR_LINE_BREAK);
  });
});

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

  it('keeps the child stderr out of the WrapperError message, which can reach an HTTP body', async () => {
    process.env.FAKE_WRAPPER_FAIL = '1';
    process.env.FAKE_WRAPPER_STDERR = 'slot 0: unit not loaded\r\nslot 0: no volume\n';
    try {
      const error = await wrapper.reset('0' as SlotName).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WrapperError);
      const wrapperError = error as WrapperError;
      expect(wrapperError.message).toMatch(/^slot wrapper failed: Command failed: [^\r\n]*$/);
      expect(wrapperError.message).not.toContain('unit not loaded');
      expect(wrapperError.message).not.toContain('forced failure');
      expect(wrapperError.stderr).toContain('slot 0: unit not loaded');
    } finally {
      delete process.env.FAKE_WRAPPER_FAIL;
      delete process.env.FAKE_WRAPPER_STDERR;
    }
  });

  it('puts the stderr on one line in the log text, control characters escaped', async () => {
    process.env.FAKE_WRAPPER_FAIL = '1';
    process.env.FAKE_WRAPPER_STDERR = 'slot 0: unit not loaded\r\nslot 0: no volume\n';
    try {
      const error = await wrapper.reset('0' as SlotName).catch((caught: unknown) => caught);
      const text = errorLogText(error);
      expect(text).not.toMatch(/\n|\r/);
      expect(text).toMatch(/^slot wrapper failed: Command failed: /);
      expect(
        text.endsWith(
          ' stderr: slot 0: unit not loaded\\r\\nslot 0: no volume\\nfake wrapper: forced failure'
        )
      ).toBe(true);
    } finally {
      delete process.env.FAKE_WRAPPER_FAIL;
      delete process.env.FAKE_WRAPPER_STDERR;
    }
  });

  it("a lone CR, or a Unicode line separator, in the first line of Node's message never reaches the WrapperError message", async () => {
    process.env.FAKE_WRAPPER_FAIL = '1';
    try {
      for (const separator of ['\r', '\u2028', '\u0085']) {
        const error = await wrapper.load(`/x${separator}y`).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WrapperError);
        expect((error as WrapperError).message).not.toMatch(CONTROL_OR_LINE_BREAK);
      }
    } finally {
      delete process.env.FAKE_WRAPPER_FAIL;
    }
  });

  it('errorLogText is the plain message for an error that is not a WrapperError', () => {
    expect(errorLogText(new Error('plain'))).toBe('plain');
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
