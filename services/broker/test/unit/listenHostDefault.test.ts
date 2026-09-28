import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEMD_DIR = join(HERE, '../../systemd');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Owner ruling (branchLeft/workspace#966, 2026-09-28, `control=a`): ops1
 * reaches this broker only through an SSH tunnel from edge1, so it must
 * never bind anything but loopback. `config.ts#loadConfig` already defaults
 * `LISTEN_HOST` to `127.0.0.1` -- proven by `config.test.ts`'s own "loads
 * every required field" case. What that test cannot catch is a *deployment
 * artefact* overriding the default: this file's own committed env template
 * or the unit file itself setting `LISTEN_HOST` to something else. Proven
 * by sabotage: setting `LISTEN_HOST=0.0.0.0` in either committed file turns
 * this suite red (see this PR's body for the recorded run).
 */
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

describe('the shipped broker env template never overrides LISTEN_HOST off loopback', () => {
  it('systemd/broker.env.example sets no LISTEN_HOST, or a loopback one', () => {
    const env = parseEnvFile(join(SYSTEMD_DIR, 'broker.env.example'));
    if (!env.has('LISTEN_HOST')) return;
    expect(LOOPBACK_HOSTS.has(env.get('LISTEN_HOST') ?? '')).toBe(true);
  });

  it('the unit file itself carries no inline Environment=LISTEN_HOST= override', () => {
    const unit = readFileSync(join(SYSTEMD_DIR, 'branchleft-broker.service'), 'utf8');
    const match = /^Environment=.*LISTEN_HOST/m.exec(unit);
    expect(match).toBeNull();
  });

  it('with the shipped template applied and nothing else set, loadConfig lands on loopback', () => {
    const env = parseEnvFile(join(SYSTEMD_DIR, 'broker.env.example'));
    const asEnv = Object.fromEntries(env) as Record<string, string>;
    const config = loadConfig(asEnv, () => Buffer.alloc(32, 1));
    expect(config.host).toBe('127.0.0.1');
  });
});
