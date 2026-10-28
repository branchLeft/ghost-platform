/**
 * The scanner health export a paying tenant renders: the six environment keys,
 * the per-tenant metrics volume mounted into both colours, and the isolation
 * that keeps one tenant from writing another's metrics. See
 * `src/environment.md#scanner-metrics-export` and `src/compose.md#the-metrics-volume`.
 *
 * Two controls are proven red-then-green inside the suite with
 * `importSabotaged` (a mutated copy of the real source, never an inline
 * re-implementation): the keys, and the slug-scoped volume name.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrivateIpV4, Slug, TenantUid, Port } from '../src/brand.js';
import { renderComposeStack } from '../src/compose.js';
import type { ComposeStackArgs } from '../src/compose.js';
import type { tenantEnvironment as TenantEnvironmentFn } from '../src/environment.js';
import {
  METRICS_MOUNT_PATH,
  METRICS_TEXTFILE_PATH,
  tenantEnvironment,
} from '../src/environment.js';
import { metricsVolumeName, secretsEnvPath } from '../src/naming.js';
import type { metricsVolumeName as MetricsVolumeNameFn } from '../src/naming.js';
import { render } from '../src/render.js';
import { uploadLimits } from '../src/runtime.js';
import { validate } from '../src/validate.js';
import {
  TEST_ZONES,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
} from './fixtures.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const FEATURES = ['images', 'media', 'files'] as const;
const PATH_KEYS = FEATURES.map((f) => `storage__${f}__metricsTextfilePath`);
const TENANT_KEYS = FEATURES.map((f) => `storage__${f}__metricsTenant`);

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, 'golden');

function envFor(
  fixture: typeof entryTenantDescriptor,
  fn: typeof TenantEnvironmentFn = tenantEnvironment
) {
  const descriptor = validate(fixture(), TEST_ZONES);
  return {
    descriptor,
    env: fn(descriptor, uploadLimits(), secretsEnvPath(descriptor.slug), TEST_ZONES),
  };
}

/** Every way an environment fails to switch the export on for `slug`, named. */
function metricsKeyProblems(
  env: Readonly<Record<string, string | number | boolean>>,
  slug: string
): string[] {
  const problems: string[] = [];
  for (const key of PATH_KEYS) {
    if (env[key] !== '/var/lib/ghost/metrics/scanner.prom') {
      problems.push(`${key} is ${String(env[key])}`);
    }
  }
  for (const key of TENANT_KEYS) {
    if (env[key] !== slug) {
      problems.push(`${key} is ${String(env[key])}`);
    }
  }
  return problems;
}

/** Every way two slugs' metrics volumes could be one volume, named. */
function isolationProblems(nameOf: typeof MetricsVolumeNameFn): string[] {
  const problems: string[] = [];
  const a = nameOf('tenant-one' as Slug);
  const b = nameOf('tenant-two' as Slug);
  if (a === b) {
    problems.push(`tenant-one and tenant-two share the metrics volume ${a}`);
  }
  if (!a.includes('tenant-one')) {
    problems.push(`${a} does not carry its slug`);
  }
  return problems;
}

describe('the scanner metrics environment keys', () => {
  it.each([
    ['entry tenant', entryTenantDescriptor],
    ['professional tenant', professionalTenantDescriptor],
  ] as const)(
    'a %s renders the exact path and its slug for all three features',
    (_label, fixture) => {
      const { descriptor, env } = envFor(fixture);
      for (const feature of FEATURES) {
        expect(env[`storage__${feature}__metricsTextfilePath`]).toBe(
          '/var/lib/ghost/metrics/scanner.prom'
        );
        expect(env[`storage__${feature}__metricsTenant`]).toBe(descriptor.slug);
      }
      expect(metricsKeyProblems(env, descriptor.slug)).toEqual([]);
    }
  );

  it('renders exactly six metrics keys, and no other key mentions metrics', () => {
    const { env } = envFor(entryTenantDescriptor);
    expect(
      Object.keys(env)
        .filter((key) => /metrics/i.test(key))
        .sort()
    ).toEqual([...PATH_KEYS, ...TENANT_KEYS].sort());
  });

  it('gives all three features identical values, since the adapter exports one file per process', () => {
    const { env } = envFor(professionalTenantDescriptor);
    expect(new Set(PATH_KEYS.map((key) => env[key])).size).toBe(1);
    expect(new Set(TENANT_KEYS.map((key) => env[key])).size).toBe(1);
  });

  it('renders a path the adapter accepts: absolute, ending .prom, inside the mounted directory', () => {
    const { env } = envFor(entryTenantDescriptor);
    const path = String(env[PATH_KEYS[0]!]);
    expect(isAbsolute(path)).toBe(true);
    expect(path.endsWith('.prom')).toBe(true);
    expect(path).toBe(METRICS_TEXTFILE_PATH);
    expect(path.startsWith(`${METRICS_MOUNT_PATH}/`)).toBe(true);
  });

  it('a demo renders no metrics key at all', () => {
    const { env } = envFor(demoDescriptor);
    expect(Object.keys(env).filter((key) => /metrics/i.test(key))).toEqual([]);
  });

  it('SABOTAGE — an environment.ts without the keys in its object-storage branch is caught; the real one is not', async () => {
    const { descriptor } = envFor(entryTenantDescriptor);
    // RED: remove the two key lines from the real source.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const lines = source.split('\n');
        const kept = lines.filter(
          (line) => !line.includes('__metricsTextfilePath`]') && !line.includes('__metricsTenant`]')
        );
        if (kept.length !== lines.length - 2) {
          throw new Error(
            'sabotage target not found in environment.ts -- update the mutation to match the current source'
          );
        }
        return kept.join('\n');
      }
    );
    const sabotagedEnv = sabotaged.tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    const problems = metricsKeyProblems(sabotagedEnv, descriptor.slug);
    expect(problems).toHaveLength(6);
    expect(problems.join('\n')).toContain('storage__images__metricsTextfilePath');
    expect(problems.join('\n')).toContain('storage__files__metricsTenant');

    // GREEN: the real module has none.
    const { env } = envFor(entryTenantDescriptor);
    expect(metricsKeyProblems(env, descriptor.slug)).toEqual([]);
  });
});

describe('the metrics volume name', () => {
  it('is ghost-<slug>-metrics', () => {
    expect(metricsVolumeName('acme' as Slug)).toBe('ghost-acme-metrics');
  });

  it('two slugs never share a metrics volume', () => {
    expect(isolationProblems(metricsVolumeName)).toEqual([]);
  });

  it('SABOTAGE — a metricsVolumeName that ignores the slug is caught; the real one is not', async () => {
    // RED: one shared volume for every tenant, the exact failure that would
    // let one tenant overwrite another's metrics.
    const sabotaged = await importSabotaged<{ metricsVolumeName: typeof MetricsVolumeNameFn }>(
      'naming.ts',
      (source) => {
        const target = 'return `ghost-${slug}-metrics`;';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in naming.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, "return 'ghost-shared-metrics';");
      }
    );
    const problems = isolationProblems(sabotaged.metricsVolumeName);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('share the metrics volume ghost-shared-metrics');

    // GREEN: the real function.
    expect(isolationProblems(metricsVolumeName)).toEqual([]);
  });
});

const baseArgs: ComposeStackArgs = {
  kind: 'tenant',
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

/** The lines of one service's block, `ghost-a` or `ghost-b`. */
function serviceBlock(yaml: string, service: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`  ${service}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The `volumes:` list of a service block. */
function serviceVolumes(block: string[]): string[] {
  const start = block.indexOf('    volumes:');
  expect(start).toBeGreaterThan(-1);
  const out: string[] = [];
  for (const line of block.slice(start + 1)) {
    if (!line.startsWith('      - ')) break;
    out.push(line.slice('      - '.length).replace(/^'|'$/g, ''));
  }
  return out;
}

/** The names under the top-level `volumes:` key. */
function declaredVolumes(yaml: string): Record<string, string[]> {
  const lines = yaml.split('\n');
  const start = lines.indexOf('volumes:');
  expect(start).toBeGreaterThan(-1);
  const out: Record<string, string[]> = {};
  let current = '';
  for (const line of lines.slice(start + 1)) {
    const name = /^ {2}(\S+):$/.exec(line);
    if (name) {
      current = name[1]!;
      out[current] = [];
    } else if (current && line.startsWith('    ')) {
      out[current]!.push(line.trim());
    }
  }
  return out;
}

describe('the metrics volume in the rendered stack', () => {
  it.each([
    ['entry tenant', entryTenantDescriptor],
    ['professional tenant', professionalTenantDescriptor],
  ] as const)(
    'a %s mounts its own metrics volume read-write in both colours and declares it external',
    (_label, fixture) => {
      const descriptor = validate(fixture(), TEST_ZONES);
      const yaml = render(descriptor, TEST_ZONES)[0]!.content;
      const expected = `ghost-${descriptor.slug}-metrics:/var/lib/ghost/metrics`;
      for (const service of ['ghost-a', 'ghost-b']) {
        const volumes = serviceVolumes(serviceBlock(yaml, service));
        expect(volumes).toContain(expected);
        // The exact entry, with no `:ro` suffix: the tenant's own process writes the file.
        expect(volumes.filter((v) => v.includes('/metrics'))).toEqual([expected]);
      }
      expect(declaredVolumes(yaml)[`ghost-${descriptor.slug}-metrics`]).toEqual(['external: true']);
    }
  );

  it('a tenant declares exactly three external volumes: content, adapters, metrics', () => {
    const yaml = renderComposeStack(baseArgs);
    expect(Object.keys(declaredVolumes(yaml)).sort()).toEqual([
      'ghost-acme-adapters',
      'ghost-acme-content',
      'ghost-acme-metrics',
    ]);
    expect(serviceVolumes(serviceBlock(yaml, 'ghost-a'))).toEqual([
      'ghost-acme-content:/var/lib/ghost/content',
      'ghost-acme-adapters:/var/lib/ghost/content/adapters:ro',
      'ghost-acme-metrics:/var/lib/ghost/metrics',
    ]);
  });

  it('the posture check still passes with the new volume mounted (a named volume, not a host path)', () => {
    expect(() => renderComposeStack(baseArgs)).not.toThrow();
  });

  it('a demo mounts nothing at the metrics path and declares no metrics volume', () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);
    const yaml = render(descriptor, TEST_ZONES)[0]!.content;
    expect(yaml).not.toContain('metrics');
    for (const service of ['ghost-a', 'ghost-b']) {
      expect(serviceVolumes(serviceBlock(yaml, service)).join('\n')).not.toContain(
        '/var/lib/ghost/metrics'
      );
    }
  });

  it('the demo compose golden names no metrics at all', () => {
    expect(readFileSync(join(goldenDir, 'demo.compose.yml'), 'utf-8')).not.toContain('metrics');
  });

  it('isolation: two tenants render two metrics volumes, and neither stack names the other', () => {
    const one = renderComposeStack({ ...baseArgs, slug: 'tenant-one' as Slug });
    const two = renderComposeStack({ ...baseArgs, slug: 'tenant-two' as Slug });
    expect(one).toContain('ghost-tenant-one-metrics');
    expect(two).toContain('ghost-tenant-two-metrics');
    expect(one).not.toContain('ghost-tenant-two');
    expect(two).not.toContain('ghost-tenant-one');
    expect(metricsVolumeName('tenant-one' as Slug)).not.toBe(
      metricsVolumeName('tenant-two' as Slug)
    );
  });
});
