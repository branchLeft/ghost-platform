import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState, writeState } from '../../src/state.js';

describe('state', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'major-watcher-state-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a written state', async () => {
    const path = join(dir, 'state.json');
    await writeState(path, { lastNotifiedMajor: 6 });
    expect(await readState(path)).toEqual({ lastNotifiedMajor: 6 });
  });

  it('refuses to run with no state file rather than defaulting to 0', async () => {
    const path = join(dir, 'missing.json');
    // This is the sabotage-tested control: see README.md "Bootstrapping".
    // A default of 0 here would make the very first live run fire a page
    // for major 6, which was announced over a year before this watcher
    // existed -- exactly the false alarm #1301 must not produce.
    await expect(readState(path)).rejects.toThrow(/no dedupe state/);
  });

  it('refuses malformed JSON', async () => {
    const path = join(dir, 'bad.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(path, 'not json'));
    await expect(readState(path)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a state file with no integer lastNotifiedMajor', async () => {
    const path = join(dir, 'bad-shape.json');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(path, JSON.stringify({ lastNotifiedMajor: 'six' }))
    );
    await expect(readState(path)).rejects.toThrow(/no valid integer/);
  });

  it('refuses a negative lastNotifiedMajor', async () => {
    const path = join(dir, 'negative.json');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(path, JSON.stringify({ lastNotifiedMajor: -1 }))
    );
    await expect(readState(path)).rejects.toThrow(/no valid integer/);
  });
});
