import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_PATH = join(HERE, '../../systemd/branchleft-broker.service');

/**
 * `RUNBOOK-broker-deploy.md`'s upgrade step swaps `/opt/branchleft/broker/
 * current` (a symlink) to a new release directory rather than overwriting
 * files in place, so a request in flight never sees half-written files.
 * That pattern is only safe with `--preserve-symlinks-main` on the `node`
 * invocation: proved by a real boot without it (this PR's body) --
 * `server.ts#isEntryPoint`'s `import.meta.url === pathToFileURL(process.argv[1]).href`
 * check resolves `import.meta.url` through the symlink to its target under
 * `releases/<release>/` but never re-resolves `argv[1]`, so the two URLs
 * disagree, `main()` silently never runs, and the unit exits
 * `0/SUCCESS` in under two seconds with nothing listening -- no log line,
 * no error, no restart (a clean exit is not `Restart=on-failure`'s job).
 * Sabotage-proven: dropping the flag from the committed unit file turns
 * this test red (see this PR's body for the recorded run).
 */
describe('the broker unit invokes node with --preserve-symlinks-main', () => {
  it('ExecStart carries the flag, ahead of the entrypoint path', () => {
    const unit = readFileSync(UNIT_PATH, 'utf8');
    const execStart = /^ExecStart=(.*)$/m.exec(unit);
    expect(execStart).not.toBeNull();
    const line = execStart?.[1] ?? '';
    expect(line).toContain('--preserve-symlinks-main');
    // Ahead of the entrypoint path, not merely present somewhere in the
    // line: node reads flags left-to-right and treats the first
    // non-flag argument as the script to run, so a flag placed after the
    // entrypoint path is passed to the SCRIPT, not to node.
    const flagIndex = line.indexOf('--preserve-symlinks-main');
    const entryIndex = line.indexOf('current/broker.mjs');
    expect(entryIndex).toBeGreaterThan(-1);
    expect(flagIndex).toBeLessThan(entryIndex);
  });
});
