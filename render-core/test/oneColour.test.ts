import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Port, PrivateIpV4, Slug, TenantUid } from '../src/brand.js';
import { FieldValidationError } from '../src/brand.js';
import { renderComposeStack } from '../src/compose.js';
import { render } from '../src/render.js';
import { validate } from '../src/validate.js';
import {
  TEST_ZONES,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
} from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

const baseArgs = {
  kind: 'tenant' as const,
  slug: 'acme' as Slug,
  uid: 30123 as TenantUid,
  appHostPrivateIp: '10.20.1.50' as PrivateIpV4,
  ports: { a: 3101 as Port, b: 3102 as Port, health: 3103 as Port },
  environment: { url: 'https://blog.acme.example' },
  limits: {
    tmpfsSize: '128m',
    themeCompressedBytes: 1,
    themeEntryUncompressedBytes: 1,
    themeTotalUncompressedBytes: 1,
    edgeRequestBodyMaxSize: '64MiB',
    memoryLimit: '640m',
  },
  caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
  dataMount: null,
  mailNetwork: null,
};

function serviceNames(yaml: string): string[] {
  return [...yaml.matchAll(/^ {2}(ghost-[ab]):$/gm)].map((m) => m[1]!);
}

describe('renderComposeStack() — activeColour renders exactly one Ghost service', () => {
  it('colour a: only ghost-a, on the a port; ghost-b and the b port are absent', () => {
    const yaml = renderComposeStack({ ...baseArgs, activeColour: 'a' });
    expect(serviceNames(yaml)).toEqual(['ghost-a']);
    expect(yaml).toContain('10.20.1.50:3101:2368');
    expect(yaml).not.toContain('ghost-b:');
    expect(yaml).not.toContain('3102');
  });

  it('colour b: only ghost-b, on the b port; ghost-a and the a port are absent', () => {
    const yaml = renderComposeStack({ ...baseArgs, activeColour: 'b' });
    expect(serviceNames(yaml)).toEqual(['ghost-b']);
    expect(yaml).toContain('10.20.1.50:3102:2368');
    expect(yaml).not.toContain('ghost-a:');
    expect(yaml).not.toContain('3101');
  });

  it('the idle colour is omitted, never parked behind a compose profile', () => {
    for (const activeColour of ['a', 'b'] as const) {
      const yaml = renderComposeStack({ ...baseArgs, activeColour });
      expect(yaml).not.toContain('profiles');
    }
  });

  it('absent activeColour renders both services, byte-identical to an explicit undefined', () => {
    const implicit = renderComposeStack(baseArgs);
    const explicit = renderComposeStack({ ...baseArgs, activeColour: undefined });
    expect(serviceNames(implicit)).toEqual(['ghost-a', 'ghost-b']);
    expect(explicit).toBe(implicit);
  });

  it('keeps the shared volumes and the mail network when one colour is active', () => {
    const yaml = renderComposeStack({
      ...baseArgs,
      mailNetwork: 'branchleft-mail-30123',
      activeColour: 'b',
    });
    expect(yaml).toContain('branchleft-mail-30123');
    expect(yaml).toContain('ghost-acme-content');
  });

  it.each(['c', 'A', '', null, 1])('refuses an activeColour of %j', (bad) => {
    expect(() => renderComposeStack({ ...baseArgs, activeColour: bad as unknown as 'a' })).toThrow(
      FieldValidationError
    );
  });
});

describe('render() — activeColour option', () => {
  const fixtures = [
    ['demo', demoDescriptor],
    ['entry-tenant', entryTenantDescriptor],
    ['professional-tenant', professionalTenantDescriptor],
  ] as const;

  it.each(fixtures)(
    'with no option, %s renders the same seven artefacts as an empty options object',
    (_label, fixture) => {
      const descriptor = validate(fixture(), TEST_ZONES);
      const plain = render(descriptor, TEST_ZONES);
      expect(render(descriptor, TEST_ZONES, undefined, {})).toEqual(plain);
      expect(render(descriptor, TEST_ZONES, undefined, { activeColour: undefined })).toEqual(plain);
    }
  );

  it.each(fixtures)(
    'with an activeColour, %s changes compose.yml only and keeps all seven artefacts',
    (_label, fixture) => {
      const descriptor = validate(fixture(), TEST_ZONES);
      const plain = render(descriptor, TEST_ZONES);
      const one = render(descriptor, TEST_ZONES, undefined, { activeColour: 'a' });
      expect(one.map((a) => a.path)).toEqual(plain.map((a) => a.path));
      for (let i = 0; i < plain.length; i += 1) {
        if (plain[i]!.path === 'compose.yml') continue;
        expect(one[i]).toEqual(plain[i]);
      }
      expect(serviceNames(one[0]!.content)).toEqual(['ghost-a']);
    }
  );

  it('an active colour b document is pinned by a golden, and its service block is the both-colours document’s ghost-b block', () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const one = render(descriptor, TEST_ZONES, undefined, { activeColour: 'b' })[0]!.content;
    const golden = readFileSync(join(here, 'golden', 'entry-tenant.compose.active-b.yml'), 'utf-8');
    expect(one).toBe(golden);

    const both = render(descriptor, TEST_ZONES)[0]!.content;
    const block = (text: string, name: string): string => {
      const start = text.indexOf(`  ${name}:\n`);
      const rest = text.slice(start + 1);
      const end = rest.search(/\n {2}ghost-[ab]:\n|\nnetworks:|\nvolumes:/);
      return rest.slice(0, end === -1 ? undefined : end);
    };
    expect(block(one, 'ghost-b')).toBe(block(both, 'ghost-b'));
  });
});
