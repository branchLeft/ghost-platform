import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_PATH = join(HERE, '../../systemd/branchleft-broker.service');

/**
 * `NoNewPrivileges=no` alone does not prove the kernel's `no_new_privs` bit
 * is actually off: several seccomp-backed directives force it regardless of
 * this setting (systemd/README.md, "`no_new_privs` is forced by more than
 * `NoNewPrivileges=`"). This asserts both halves: the explicit override,
 * and that none of the directives known to force it anyway are present.
 */
const FORCES_NO_NEW_PRIVS = [
  'SystemCallFilter',
  'SystemCallArchitectures',
  'RestrictAddressFamilies',
  'RestrictNamespaces',
  'RestrictRealtime',
  'LockPersonality',
  'RestrictSUIDSGID',
  'MemoryDenyWriteExecute',
  'ProtectClock',
  'ProtectKernelTunables',
  'ProtectKernelModules',
  'ProtectKernelLogs',
  'ProtectHostname',
];

describe('the broker unit explicitly overrides NoNewPrivileges', () => {
  it('sets NoNewPrivileges=no, not merely omitting NoNewPrivileges=yes', () => {
    const unit = readFileSync(UNIT_PATH, 'utf8');
    const match = /^NoNewPrivileges=(\S+)/m.exec(unit);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('no');
  });

  it('carries none of the seccomp-backed directives that force no_new_privs regardless of NoNewPrivileges=no', () => {
    const unit = readFileSync(UNIT_PATH, 'utf8');
    const present = FORCES_NO_NEW_PRIVS.filter((name) => new RegExp(`^${name}=`, 'm').test(unit));
    expect(present).toEqual([]);
  });
});
