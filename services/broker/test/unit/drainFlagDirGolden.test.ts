import { readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { loadConfig } from '../../src/config.js';
import { createDrainFlagStore } from '../../src/drainFlag.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEMD_DIR = join(HERE, '../../systemd');
const GOLDEN_PATH = join(HERE, '../../../../demo-host/provision/drain-flag-dir.golden.json');

interface GoldenDrainFlagDir {
  readonly dir: string;
  readonly parent: string;
  readonly parentMode: string;
  readonly stateDirectory: string;
  readonly files: readonly {
    readonly slot: string;
    readonly colour: 'a' | 'b';
    readonly name: string;
  }[];
}

const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenDrainFlagDir;

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

/**
 * The drain-flag directory is shared with the sidecars the host-side Python
 * provisions and mounts. The same golden fixture pins their side
 * (demo-host/provision/test_drain_flag_dir.py), so neither can move alone.
 */
describe('the broker drain-flag directory, pinned to drain-flag-dir.golden.json', () => {
  const envFile = join(SYSTEMD_DIR, 'broker.env.example');

  it('the shipped env template names the golden directory', () => {
    expect(parseEnvFile(envFile).get('BROKER_DRAIN_FLAG_DIR')).toBe(golden.dir);
  });

  it('loadConfig over the shipped env template yields the golden directory', () => {
    const env = Object.fromEntries(parseEnvFile(envFile));
    expect(loadConfig(env, () => Buffer.alloc(32, 1)).drainFlagDir).toBe(golden.dir);
  });

  it('the directory sits under the broker unit StateDirectory, so it is on disk and survives a reboot', () => {
    const unit = readFileSync(join(SYSTEMD_DIR, 'branchleft-broker.service'), 'utf8');
    const match = /^StateDirectory=(\S+)$/m.exec(unit);
    expect(match?.[1]).toBe(golden.stateDirectory);
    expect(golden.parent).toBe(`/var/lib/${golden.stateDirectory}`);
    expect(golden.dir.startsWith(`${golden.parent}/`)).toBe(true);
    for (const volatile of ['/run/', '/var/run/', '/tmp/', '/dev/shm/']) {
      expect(golden.dir.startsWith(volatile)).toBe(false);
    }
  });

  it('the unit StateDirectoryMode is the golden parent mode', () => {
    const unit = readFileSync(join(SYSTEMD_DIR, 'branchleft-broker.service'), 'utf8');
    expect(/^StateDirectoryMode=(\S+)$/m.exec(unit)?.[1]).toBe(golden.parentMode);
  });

  describe('flag file names', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await makeTempDir('broker-drainflag-golden-');
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('the store writes exactly the golden file name for every slot and colour', async () => {
      const store = createDrainFlagStore(dir);
      for (const entry of golden.files) {
        await store.set(entry.slot as SlotName, entry.colour);
      }
      expect((await readdir(dir)).sort()).toEqual(golden.files.map((entry) => entry.name).sort());
      expect(golden.files).toHaveLength(14);
    });
  });
});
