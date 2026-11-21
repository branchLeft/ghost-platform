// The queue starts from a journal a previous process wrote, which may hold
// anything a crash or a bad write left. Each odd line is skipped and counted;
// none stops the start and none is read as a hash or a verdict.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { hashOf } from '../helpers/verdict-host-rig.mjs';

const require = createRequire(import.meta.url);
const { VerdictQueue } = require('../../verdict-host/queue.js');

interface Queue {
  open(): Queue;
  close(): void;
  ask(hash: string): { status: string; verdict?: Record<string, unknown> };
  counts(): { queued: number };
}

let directory: string | undefined;
const opened: Queue[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function replay(lines: string[]): { queue: Queue; logged: string[] } {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-queue-replay-'));
  const file = path.join(directory, 'queue.journal');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  const logged: string[] = [];
  const queue = new VerdictQueue({
    journalFile: file,
    logger: { error: (line: string) => logged.push(String(line)) },
  }).open() as Queue;
  opened.push(queue);
  return { queue, logged };
}

const now = Date.now();

describe('replaying a journal', () => {
  it('skips what is not a record, counts it, and keeps what is', () => {
    const queued = hashOf(1);
    const { queue, logged } = replay([
      'null',
      '5',
      '{"t":"q","at":1}',
      `{"t":"q","h":"${queued}","at":"not a number"}`,
      `{"t":"v","h":"${hashOf(9)}","at":${now}}`,
      `{"t":"?","h":"${hashOf(9)}","at":${now}}`,
      'not json at all',
      `{"t":"q","h":"${queued}","at":${now}}`,
    ]);

    expect(queue.counts().queued).toBe(1);
    expect(logged.some((l) => /JOURNAL_SKIPPED_LINES count=7/.test(l))).toBe(true);
  });

  it('keeps the first time a hash was queued when it is queued again', () => {
    const hash = hashOf(2);
    const { queue } = replay([
      `{"t":"q","h":"${hash}","at":${now - 5000}}`,
      `{"t":"q","h":"${hash}","at":${now}}`,
    ]);
    expect(queue.counts().queued).toBe(1);
  });

  it('answers a replayed verdict with its match type when it had one, and without when it had none', () => {
    const exact = hashOf(3);
    const plain = hashOf(4);
    const { queue } = replay([
      `{"t":"v","h":"${exact}","at":${now},"c":"csam","m":"exact"}`,
      `{"t":"v","h":"${plain}","at":${now},"c":"harmful-abusive-material"}`,
    ]);

    expect(queue.ask(exact).verdict).toMatchObject({ classification: 'csam', matchType: 'exact' });
    const answer = queue.ask(plain).verdict;
    expect(answer).toMatchObject({ classification: 'harmful-abusive-material' });
    expect(answer).not.toHaveProperty('matchType');
  });

  it('a verdict replayed after a queueing settles it, and a queueing after a verdict reopens it', () => {
    const hash = hashOf(5);
    const settled = replay([
      `{"t":"q","h":"${hash}","at":${now}}`,
      `{"t":"v","h":"${hash}","at":${now},"c":"csam","m":"near"}`,
    ]);
    expect(settled.queue.counts().queued).toBe(0);
    settled.queue.close();
    opened.pop();
    fs.rmSync(directory as string, { recursive: true, force: true });

    const reopened = replay([
      `{"t":"v","h":"${hash}","at":${now},"c":"csam","m":"near"}`,
      `{"t":"q","h":"${hash}","at":${now}}`,
    ]);
    expect(reopened.queue.counts().queued).toBe(1);
  });
});
