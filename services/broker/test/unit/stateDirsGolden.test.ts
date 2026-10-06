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

function readWritePaths(): string[] {
  const unit = readFileSync(join(SYSTEMD_DIR, 'branchleft-broker.service'), 'utf8');
  return unit
    .split('\n')
    .filter((line) => line.startsWith('ReadWritePaths='))
    .flatMap((line) => line.slice('ReadWritePaths='.length).trim().split(/\s+/));
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
