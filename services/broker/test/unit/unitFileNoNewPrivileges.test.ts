import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_PATH = join(HERE, '../../systemd/branchleft-broker.service');

/**
 * The issue this unit exists for (branchLeft/workspace#1545) already names
 * `NoNewPrivileges=yes` as incompatible with the `sudo -n` call this
 * service makes: sudo needs the kernel to honour its own setuid-root bit on
 * exec, which `NoNewPrivileges` blocks outright. Kept explicit rather than
 * relying on systemd's own default (also "no"): a real boot proved that
 * several seccomp-backed directives -- `SystemCallFilter=`,
 * `RestrictNamespaces=`, `RestrictSUIDSGID=`, and others the unit file's
 * own header comment lists -- force the kernel's `no_new_privs` bit on a
 * non-root `User=` REGARDLESS of what `NoNewPrivileges=` is configured to
 * (`seccomp(2)`: installing a filter without `CAP_SYS_ADMIN` requires it).
 * None of those directives are set on this unit any more for exactly that
 * reason; this explicit `no` is the line a future edit re-adding one of
 * them would need to notice contradicts. Sabotage-proven: removing this
 * line turns this test red (see this PR's body for the recorded run).
 */
describe('the broker unit explicitly overrides NoNewPrivileges', () => {
  it('sets NoNewPrivileges=no, not merely omitting NoNewPrivileges=yes', () => {
    const unit = readFileSync(UNIT_PATH, 'utf8');
    const match = /^NoNewPrivileges=(\S+)/m.exec(unit);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('no');
  });
});
