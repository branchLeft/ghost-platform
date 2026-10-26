import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_PATH = join(HERE, '../../systemd/branchleft-broker.service');

/**
 * systemd reads the start-rate limit (`StartLimitIntervalSec=`, `StartLimitBurst=`)
 * only from `[Unit]`. In `[Service]` it is not an error, so the unit still loads,
 * but the limit silently never applies, and a crash loop is respawned without bound.
 * Each key is asserted in `[Unit]` with its value, and absent from `[Service]`.
 */
const START_LIMIT_KEYS = {
  StartLimitIntervalSec: '300',
  StartLimitBurst: '6',
} as const;

/** Return the `key=value` pairs of each section, keyed by section name. */
function parseSections(unit: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of unit.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = new Map<string, string>();
      sections.set(header[1] ?? '', current);
      continue;
    }
    const pair = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (pair && current) current.set(pair[1] ?? '', pair[2] ?? '');
  }
  return sections;
}

describe('the broker unit sets its start limit in [Unit], where systemd reads it', () => {
  const sections = parseSections(readFileSync(UNIT_PATH, 'utf8'));
  const unitSection = sections.get('Unit') ?? new Map<string, string>();
  const serviceSection = sections.get('Service') ?? new Map<string, string>();

  it('has a [Unit] section and a [Service] section', () => {
    expect(sections.has('Unit')).toBe(true);
    expect(sections.has('Service')).toBe(true);
  });

  for (const [key, value] of Object.entries(START_LIMIT_KEYS)) {
    it(`sets ${key}=${value} in [Unit]`, () => {
      expect(unitSection.get(key)).toBe(value);
    });

    it(`does not set ${key} in [Service]`, () => {
      expect(serviceSection.has(key)).toBe(false);
    });
  }
});
