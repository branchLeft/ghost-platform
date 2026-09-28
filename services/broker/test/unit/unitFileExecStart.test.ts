import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_PATH = join(HERE, '../../systemd/branchleft-broker.service');

/**
 * Without --preserve-symlinks-main, the `current` symlink swap silently
 * defeats server.ts's own entrypoint check -- see systemd/README.md.
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
