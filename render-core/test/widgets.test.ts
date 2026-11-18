/**
 * The own-origin widget keys: what `tenantEnvironment()` renders for them, that
 * the list is the one `widgets/pins.json` pins, and that `render()` carries the
 * option through to `compose.yml` alone. See environment.md#widget-origin.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OWN_ORIGIN_WIDGETS,
  WIDGET_ASSET_PATH_PREFIX,
  tenantEnvironment,
} from '../src/environment.js';
import { secretsEnvPath } from '../src/naming.js';
import { render } from '../src/render.js';
import { uploadLimits } from '../src/runtime.js';
import { validate } from '../src/validate.js';
import {
  TEST_ZONES,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
} from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

interface PinRow {
  readonly envVar: string;
  readonly servedPath: string;
}

function pinnedRows(): readonly PinRow[] {
  const pins = JSON.parse(
    readFileSync(join(here, '..', '..', 'widgets', 'pins.json'), 'utf-8')
  ) as {
    bundles: PinRow[];
  };
  return pins.bundles;
}

const LIMITS = uploadLimits();
const fixtures = [
  ['demo', demoDescriptor],
  ['entry tenant', entryTenantDescriptor],
  ['professional tenant', professionalTenantDescriptor],
] as const;

function environmentOf(
  fixture: (typeof fixtures)[number][1],
  widgets?: 'cdn' | 'own-origin'
): Record<string, string | number | boolean> {
  const descriptor = validate(fixture(), TEST_ZONES);
  return tenantEnvironment(
    descriptor,
    LIMITS,
    secretsEnvPath(descriptor.slug),
    TEST_ZONES,
    widgets
  );
}

describe('own-origin widgets — tenantEnvironment()', () => {
  it.each(fixtures)('renders no widget key by default, for a %s', (_label, fixture) => {
    const env = environmentOf(fixture);
    for (const key of Object.keys(OWN_ORIGIN_WIDGETS)) {
      expect(env).not.toHaveProperty(key);
    }
    expect(environmentOf(fixture, 'cdn')).toEqual(env);
  });

  it.each(fixtures)('renders all seven keys on the site origin, for a %s', (_label, fixture) => {
    const env = environmentOf(fixture, 'own-origin');
    const siteUrl = String(env.url);
    const widgetKeys = Object.keys(env).filter((key) => key in OWN_ORIGIN_WIDGETS);
    expect(widgetKeys).toHaveLength(7);
    for (const key of widgetKeys) {
      const value = String(env[key]);
      expect(value.startsWith(`${siteUrl}${WIDGET_ASSET_PATH_PREFIX}/`)).toBe(true);
      expect(new URL(value).origin).toBe(new URL(siteUrl).origin);
    }
  });

  it('changes nothing but the seven widget keys', () => {
    const plain = environmentOf(entryTenantDescriptor);
    const own = environmentOf(entryTenantDescriptor, 'own-origin');
    const added = Object.keys(own).filter((key) => !(key in plain));
    expect(added.sort()).toEqual(Object.keys(OWN_ORIGIN_WIDGETS).sort());
    for (const key of Object.keys(plain)) {
      expect(own[key]).toBe(plain[key]);
    }
  });

  it('does not double the slash when the site URL ends in one', () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const env = tenantEnvironment(
      { ...descriptor, siteUrl: `${descriptor.siteUrl}/` as typeof descriptor.siteUrl },
      LIMITS,
      secretsEnvPath(descriptor.slug),
      TEST_ZONES,
      'own-origin'
    );
    expect(env.portal__url).toBe(`${descriptor.siteUrl}/bl-assets/portal.min.js`);
  });
});

describe('own-origin widgets — the pins', () => {
  it('names the same seven keys and files as widgets/pins.json', () => {
    const rows = pinnedRows();
    expect(rows).toHaveLength(7);
    const fromPins: Record<string, string> = {};
    for (const row of rows) {
      fromPins[row.envVar] = row.servedPath;
    }
    const fromRenderer: Record<string, string> = {};
    for (const [key, file] of Object.entries(OWN_ORIGIN_WIDGETS)) {
      fromRenderer[key] = `${WIDGET_ASSET_PATH_PREFIX}/${file}`;
    }
    expect(fromRenderer).toEqual(fromPins);
  });
});

describe('own-origin widgets — render()', () => {
  it.each(fixtures)('with no option renders %s byte-identically to before', (_label, fixture) => {
    const descriptor = validate(fixture(), TEST_ZONES);
    const plain = render(descriptor, TEST_ZONES);
    expect(render(descriptor, TEST_ZONES, undefined, { widgets: 'cdn' })).toEqual(plain);
    expect(render(descriptor, TEST_ZONES, undefined, { widgets: undefined })).toEqual(plain);
  });

  it.each(fixtures)('with own-origin changes compose.yml only, for a %s', (_label, fixture) => {
    const descriptor = validate(fixture(), TEST_ZONES);
    const plain = render(descriptor, TEST_ZONES);
    const own = render(descriptor, TEST_ZONES, undefined, { widgets: 'own-origin' });
    expect(own.map((a) => a.path)).toEqual(plain.map((a) => a.path));
    for (let i = 0; i < plain.length; i += 1) {
      if (plain[i]!.path === 'compose.yml') {
        expect(own[i]!.content).not.toBe(plain[i]!.content);
        // Both colours carry the keys.
        expect(own[i]!.content.match(/portal__url:/g)).toHaveLength(2);
      } else {
        expect(own[i]).toEqual(plain[i]);
      }
    }
  });

  it('pins the own-origin entry tenant compose.yml to a golden', () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const own = render(descriptor, TEST_ZONES, undefined, { widgets: 'own-origin' })[0]!.content;
    const golden = readFileSync(
      join(here, 'golden', 'entry-tenant.compose.own-origin-widgets.yml'),
      'utf-8'
    );
    expect(own).toBe(golden);
  });
});
