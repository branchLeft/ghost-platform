import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEMD_DIR = join(HERE, '../../systemd');
const BOOT_DOCKERFILE = join(HERE, '../live/fixtures/systemd-boot/Dockerfile');
const GOLDEN_PATH = join(HERE, '../../../../demo-host/provision/state-dirs.golden.json');

interface GoldenStateDirs {
  readonly stateRoot: string;
  readonly routerRoot: string;
  readonly brokerSlotsDir: string;
  readonly brokerSlotsFile: string;
  readonly dockerVolumeRoot: string;
}

const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenStateDirs;

function parseEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

const SHIPPED_UNIT = readFileSync(join(SYSTEMD_DIR, 'branchleft-broker.service'), 'utf8');

function readWritePaths(unit: string = SHIPPED_UNIT): string[] {
  return unit
    .split('\n')
    .filter((line) => line.startsWith('ReadWritePaths='))
    .flatMap((line) => line.slice('ReadWritePaths='.length).trim().split(/\s+/));
}

/**
 * The exact set the unit may write. The two state paths come from the golden
 * file; the other two are the broker's install and config trees, which the
 * golden file does not carry. A new writable path is a deliberate change that
 * edits this list in the same commit as the unit.
 */
const EXPECTED_WRITABLE: readonly string[] = [
  '/opt/branchleft',
  '/etc/branchleft',
  golden.brokerSlotsDir,
  golden.dockerVolumeRoot,
];

/** What differs between the unit's writable set and the expected one. */
function writableSetDrift(actual: readonly string[]): { extra: string[]; missing: string[] } {
  return {
    extra: [...new Set(actual.filter((path) => !EXPECTED_WRITABLE.includes(path)))].sort(),
    missing: EXPECTED_WRITABLE.filter((path) => !actual.includes(path)).sort(),
  };
}

/**
 * The broker's account must not be able to rename the health router's
 * directory, which sits beside the slots file under /var/lib/branchleft. The
 * state root stays root-owned, so the broker's only writable path there is its
 * own subdirectory. The same golden fixture pins the host-side provisioning
 * (demo-host/provision/test_state_dirs.py).
 */
describe('the broker slots file, pinned to state-dirs.golden.json', () => {
  it('the shipped env template names the golden slots file', () => {
    expect(parseEnvFile(join(SYSTEMD_DIR, 'broker.env.example')).get('BROKER_SLOTS_FILE')).toBe(
      golden.brokerSlotsFile
    );
  });

  it('the boot proof installs the shipped template, so it names the golden slots file too', () => {
    expect(readFileSync(BOOT_DOCKERFILE, 'utf8')).toContain(
      'COPY services/broker/systemd/broker.env.example /etc/branchleft/broker.env'
    );
  });

  it('loadConfig over the shipped env template yields the golden slots file', () => {
    const env = Object.fromEntries(parseEnvFile(join(SYSTEMD_DIR, 'broker.env.example')));
    expect(loadConfig(env, () => Buffer.alloc(32, 1)).slotsPath).toBe(golden.brokerSlotsFile);
  });

  it('the slots file is directly inside the broker subdirectory, beside the router root', () => {
    expect(dirname(golden.brokerSlotsFile)).toBe(golden.brokerSlotsDir);
    expect(dirname(golden.brokerSlotsDir)).toBe(golden.stateRoot);
    expect(dirname(golden.routerRoot)).toBe(golden.stateRoot);
  });

  it('the unit makes the broker subdirectory writable and never the state root or the router root', () => {
    const writable = readWritePaths();
    expect(writable).toContain(golden.brokerSlotsDir);
    for (const path of writable) {
      expect(path).not.toBe(golden.stateRoot);
      expect(path === golden.routerRoot || path.startsWith(`${golden.routerRoot}/`)).toBe(false);
    }
  });
});

/**
 * The two path-specific tests above and below only check what the unit does
 * contain and what it must not. Neither would notice a new sibling such as
 * /var/lib/docker/containers, so the whole set is pinned here, in both
 * directions, with the sabotage shown against the real unit text.
 */
describe('the unit writable set, pinned exactly', () => {
  it('ReadWritePaths= is exactly the expected set, with no duplicates', () => {
    const actual = readWritePaths();
    expect(writableSetDrift(actual)).toEqual({ extra: [], missing: [] });
    expect(actual).toHaveLength(EXPECTED_WRITABLE.length);
  });

  it('sabotage: an extra path in the unit is reported', () => {
    const sabotaged = SHIPPED_UNIT.replace(
      /^ReadWritePaths=.*$/m,
      (line) => `${line} /var/lib/docker/containers`
    );
    expect(sabotaged).not.toBe(SHIPPED_UNIT);
    expect(writableSetDrift(readWritePaths(sabotaged))).toEqual({
      extra: ['/var/lib/docker/containers'],
      missing: [],
    });
  });

  it('sabotage: a path removed from the unit is reported', () => {
    const sabotaged = SHIPPED_UNIT.replace(/^ReadWritePaths=.*$/m, (line) =>
      line.replace(` ${golden.dockerVolumeRoot}`, '')
    );
    expect(sabotaged).not.toBe(SHIPPED_UNIT);
    expect(writableSetDrift(readWritePaths(sabotaged))).toEqual({
      extra: [],
      missing: [golden.dockerVolumeRoot],
    });
  });

  it('sabotage: a second ReadWritePaths= line is reported', () => {
    const sabotaged = `${SHIPPED_UNIT}\nReadWritePaths=/var/lib/docker/containers\n`;
    expect(writableSetDrift(readWritePaths(sabotaged)).extra).toEqual([
      '/var/lib/docker/containers',
    ]);
  });
});

/**
 * The slot wrapper empties tenant volumes under the Docker volume root, and
 * the unit's read-only mount namespace is inherited through `sudo -n`, so the
 * volumes directory (and only it) must be writable. See systemd/README.md.
 */
describe('the Docker volume root, pinned to state-dirs.golden.json', () => {
  it('the unit makes the volumes directory writable', () => {
    expect(readWritePaths()).toContain(golden.dockerVolumeRoot);
  });

  it('no writable path is /var/lib/docker itself or a parent of the volumes directory', () => {
    const engineRoot = dirname(golden.dockerVolumeRoot);
    for (const path of readWritePaths()) {
      expect(path === '/' || path === engineRoot || engineRoot.startsWith(`${path}/`)).toBe(false);
    }
  });

  it('the boot proof creates the volumes directory, so the unit still starts', () => {
    expect(readFileSync(BOOT_DOCKERFILE, 'utf8')).toContain(golden.dockerVolumeRoot);
  });
});
