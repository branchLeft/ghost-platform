/**
 * The descriptor's `safety.verdictSource` switch: what it renders into a
 * slot's environment and Compose stack, that it is off unless a descriptor
 * names it, and that a demo cannot name it. See
 * `src/environment.md#verdict-source` and `src/compose.md#the-verdict-volume`.
 *
 * Three controls are proven red-then-green inside the suite with
 * `importSabotaged` (a mutated copy of the real source): off by default, the
 * demo refusal, and the read-only mount.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FieldValidationError } from '../src/brand.js';
import type { TenantDescriptor } from '../src/descriptor.js';
import type { tenantEnvironment as TenantEnvironmentFn } from '../src/environment.js';
import { tenantEnvironment } from '../src/environment.js';
import { secretsEnvPath } from '../src/naming.js';
import { render } from '../src/render.js';
import type { render as RenderFn } from '../src/render.js';
import { uploadLimits } from '../src/runtime.js';
import { validate } from '../src/validate.js';
import type { validate as ValidateFn } from '../src/validate.js';
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
const SOCKET_PATH = '/var/lib/ghost/verdict/verdict.sock';
const MOUNT_PATH = '/var/lib/ghost/verdict';

function withVerdictSource(
  fixture: () => TenantDescriptor,
  verdictSource: unknown
): TenantDescriptor {
  const descriptor = fixture();
  return {
    ...descriptor,
    safety: { ...descriptor.safety, verdictSource },
  } as unknown as TenantDescriptor;
}

function envOf(
  descriptor: TenantDescriptor,
  fn: typeof TenantEnvironmentFn = tenantEnvironment
): Record<string, string | number | boolean> {
  return fn(descriptor, uploadLimits(), secretsEnvPath(descriptor.slug), TEST_ZONES);
}

function composeOf(descriptor: TenantDescriptor, fn: typeof RenderFn = render): string {
  const artefact = fn(descriptor, TEST_ZONES).find((a) => a.path === 'compose.yml');
  if (!artefact) throw new Error('render() produced no compose.yml');
  return artefact.content;
}

/** Every way an environment fails to name the production source and its socket. */
function productionKeyProblems(env: Readonly<Record<string, string | number | boolean>>): string[] {
  const problems: string[] = [];
  for (const feature of FEATURES) {
    if (env[`storage__${feature}__verdictSource`] !== 'production') {
      problems.push(
        `storage__${feature}__verdictSource is ${String(env[`storage__${feature}__verdictSource`])}`
      );
    }
    if (env[`storage__${feature}__verdictSocketPath`] !== SOCKET_PATH) {
      problems.push(
        `storage__${feature}__verdictSocketPath is ${String(env[`storage__${feature}__verdictSocketPath`])}`
      );
    }
  }
  return problems;
}

/** Every verdict key an environment carries, by name. */
function verdictKeys(env: Readonly<Record<string, string | number | boolean>>): string[] {
  return Object.keys(env).filter((key) => /verdict/i.test(key));
}

describe('safety.verdictSource = "production" on a paying tenant', () => {
  it.each([
    ['entry tenant', entryTenantDescriptor],
    ['professional tenant', professionalTenantDescriptor],
  ] as const)(
    'a %s renders production and the socket path for all three features',
    (_l, fixture) => {
      const descriptor = validate(withVerdictSource(fixture, 'production'), TEST_ZONES);
      const env = envOf(descriptor);
      expect(productionKeyProblems(env)).toEqual([]);
      expect(verdictKeys(env)).toHaveLength(6);
      expect(Object.values(env)).not.toContain('in-process-fake');
    }
  );

  it('mounts the slot verdict volume read-only in both colours and declares it external', () => {
    const descriptor = validate(withVerdictSource(entryTenantDescriptor, 'production'), TEST_ZONES);
    const yaml = composeOf(descriptor);
    const volume = `ghost-${descriptor.slug}-verdict`;
    const mountLine = `      - '${volume}:${MOUNT_PATH}:ro'`;
    expect(yaml.split('\n').filter((line) => line === mountLine)).toHaveLength(2);
    expect(yaml).toContain(`  ${volume}:\n    external: true`);
    expect(yaml).not.toContain(`${volume}:${MOUNT_PATH}'`);
  });

  it('two slugs never share a verdict volume', () => {
    const one = validate(withVerdictSource(entryTenantDescriptor, 'production'), TEST_ZONES);
    const two = validate(withVerdictSource(professionalTenantDescriptor, 'production'), TEST_ZONES);
    expect(one.slug).not.toBe(two.slug);
    expect(composeOf(one)).not.toContain(`ghost-${two.slug}-verdict`);
    expect(composeOf(two)).not.toContain(`ghost-${one.slug}-verdict`);
  });
});

describe('off unless a descriptor names it', () => {
  it.each([
    ['absent', undefined],
    ['"none"', 'none'],
  ] as const)(
    'with safety.verdictSource %s a tenant renders no verdict key and no verdict volume',
    (_l, value) => {
      const descriptor = validate(
        value === undefined
          ? entryTenantDescriptor()
          : withVerdictSource(entryTenantDescriptor, value),
        TEST_ZONES
      );
      expect(verdictKeys(envOf(descriptor))).toEqual([]);
      expect(composeOf(descriptor)).not.toContain('-verdict');
    }
  );

  it.each([
    ['a wrong case', 'Production'],
    ['padding', ' production'],
    ['the test fake', 'in-process-fake'],
    ['a boolean', true],
    ['an empty string', ''],
    ['null', null],
  ] as const)('validate() refuses %s', (_l, value) => {
    expect(() => validate(withVerdictSource(entryTenantDescriptor, value), TEST_ZONES)).toThrow(
      FieldValidationError
    );
  });

  it('SABOTAGE — an environment.ts that renders production by default is caught; the real one is not', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    // RED: drop the switch, so every scanning tenant names production.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const target = "safety.verdictSource === 'production'";
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in environment.ts -- update the mutation');
        }
        return source.replace(target, 'true');
      }
    );
    expect(verdictKeys(envOf(descriptor, sabotaged.tenantEnvironment))).toHaveLength(6);

    // GREEN: the real module renders nothing for a descriptor that names nothing.
    expect(verdictKeys(envOf(descriptor))).toEqual([]);
  });
});

// The owner's ruling keeps a demo's upload route refusing until the demo's own
// go-live gate sees a real verdict source. A demo descriptor that names one is
// refused outright, not rendered.
describe('a demo', () => {
  it('renders no verdict key and no verdict volume by default', () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);
    expect(verdictKeys(envOf(descriptor))).toEqual([]);
    expect(composeOf(descriptor)).not.toContain('-verdict');
  });

  it('is refused when it names production, with the field named', () => {
    expect(() => validate(withVerdictSource(demoDescriptor, 'production'), TEST_ZONES)).toThrow(
      expect.objectContaining({ name: 'FieldValidationError', field: 'safety.verdictSource' })
    );
  });

  it('may say "none" outright', () => {
    expect(() => validate(withVerdictSource(demoDescriptor, 'none'), TEST_ZONES)).not.toThrow();
  });

  it('SABOTAGE — a validate.ts without the demo refusal is caught; the real one is not', async () => {
    // RED: remove the demo refusal.
    const sabotaged = await importSabotaged<{ validate: typeof ValidateFn }>(
      'validate.ts',
      (source) => {
        const target = "descriptor.kind === 'demo' && verdictSource === 'production'";
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in validate.ts -- update the mutation');
        }
        return source.replace(target, 'false');
      }
    );
    const accepted = sabotaged.validate(
      withVerdictSource(demoDescriptor, 'production'),
      TEST_ZONES
    );
    expect(accepted.kind).toBe('demo');

    // GREEN: the real one refuses.
    expect(() => validate(withVerdictSource(demoDescriptor, 'production'), TEST_ZONES)).toThrow(
      FieldValidationError
    );
  });
});

function withInbound(fixture: () => TenantDescriptor, inbound: unknown): TenantDescriptor {
  const descriptor = fixture();
  return {
    ...descriptor,
    safety: { ...descriptor.safety, inbound },
  } as unknown as TenantDescriptor;
}

const VALID_INBOUND = { port: 8443, tls: 'pinned-private' } as const;
const INBOUND_KEYS = ['VERDICT_HOST_INBOUND_PORT', 'VERDICT_HOST_INBOUND_TLS'] as const;

/** The field a validate() refusal names; fails the test if it is not a FieldValidationError. */
function refusedField(descriptor: TenantDescriptor): string {
  try {
    validate(descriptor, TEST_ZONES);
  } catch (error) {
    if (error instanceof FieldValidationError) return error.field;
    throw error;
  }
  throw new Error('validate() accepted the descriptor; a refusal was expected');
}

/** Every host-end key that names a key, certificate or file, by name. */
function keyPathKeys(env: Readonly<Record<string, string | number | boolean>>): string[] {
  return Object.keys(env).filter(
    (key) => key.startsWith('VERDICT_HOST') && /KEY|CERT|FILE/.test(key)
  );
}

/** Every rendered artefact's lines, keyed by artefact path. */
function renderedLines(descriptor: TenantDescriptor): Map<string, string[]> {
  const lines = new Map<string, string[]>();
  for (const artefact of render(descriptor, TEST_ZONES)) {
    lines.set(artefact.path, artefact.content.split('\n'));
  }
  return lines;
}

describe('safety.inbound on a production paying tenant', () => {
  it('renders the two host-end keys with the declared port and mode', () => {
    const withBlock = envOf(
      validate(
        withInbound(() => withVerdictSource(entryTenantDescriptor, 'production'), VALID_INBOUND),
        TEST_ZONES
      )
    );
    expect(withBlock.VERDICT_HOST_INBOUND_PORT).toBe('8443');
    expect(withBlock.VERDICT_HOST_INBOUND_TLS).toBe('pinned-private');
  });

  it('differs from the same descriptor without the block in exactly those two keys', () => {
    const without = envOf(
      validate(withVerdictSource(entryTenantDescriptor, 'production'), TEST_ZONES)
    );
    const withBlock = envOf(
      validate(
        withInbound(() => withVerdictSource(entryTenantDescriptor, 'production'), VALID_INBOUND),
        TEST_ZONES
      )
    );
    const added = Object.keys(withBlock).filter((key) => !(key in without));
    expect(added.sort()).toEqual([...INBOUND_KEYS]);
    expect(Object.keys(without).filter((key) => !(key in withBlock))).toEqual([]);
    for (const key of Object.keys(without)) {
      expect(withBlock[key]).toBe(without[key]);
    }
  });

  it('accepts the two boundary ports, 1 and 65535', () => {
    for (const port of [1, 65535]) {
      const descriptor = validate(
        withInbound(() => withVerdictSource(entryTenantDescriptor, 'production'), {
          port,
          tls: 'pinned-private',
        }),
        TEST_ZONES
      );
      expect(envOf(descriptor).VERDICT_HOST_INBOUND_PORT).toBe(String(port));
    }
  });

  it('renders no address, key or certificate path, and no PEM marker, in any artefact it adds to', () => {
    const base = validate(withVerdictSource(entryTenantDescriptor, 'production'), TEST_ZONES);
    const withBlock = validate(
      withInbound(() => withVerdictSource(entryTenantDescriptor, 'production'), VALID_INBOUND),
      TEST_ZONES
    );
    const before = renderedLines(base);
    const after = renderedLines(withBlock);
    expect([...after.keys()]).toEqual([...before.keys()]);
    const added: string[] = [];
    for (const [path, lines] of after) {
      const existing = new Set(before.get(path));
      added.push(...lines.filter((line) => !existing.has(line)));
    }
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((line) => !/VERDICT_HOST_INBOUND_(PORT|TLS)\b/.test(line))).toEqual([]);
    const addedText = added.join('\n');
    expect(addedText).not.toMatch(/KEY|CERT|\.pem|\.key|\.crt|\/var\/|\/etc\//i);
    expect(addedText).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(addedText).not.toContain('BEGIN');
    expect(addedText).not.toMatch(/:\s*[0-9a-f:]{6,}\s*$/im);
  });
});

describe('safety.inbound is absent or refused without production', () => {
  it.each([
    ['absent', () => entryTenantDescriptor()],
    ['"none"', () => withVerdictSource(entryTenantDescriptor, 'none')],
  ] as const)('with verdictSource %s neither host-end key is rendered', (_l, fixture) => {
    const env = envOf(validate(fixture(), TEST_ZONES));
    for (const key of INBOUND_KEYS) expect(env).not.toHaveProperty(key);
  });

  it.each([
    ['absent', () => entryTenantDescriptor()],
    ['"none"', () => withVerdictSource(entryTenantDescriptor, 'none')],
  ] as const)('validate() refuses an inbound block with verdictSource %s', (_l, fixture) => {
    const descriptor = fixture();
    expect(refusedField(withInbound(() => descriptor, VALID_INBOUND))).toBe('safety.inbound');
  });
});

describe('safety.inbound refusals', () => {
  const production = (): TenantDescriptor => withVerdictSource(entryTenantDescriptor, 'production');
  const refusals: ReadonlyArray<readonly [string, unknown, string]> = [
    ['port 0', { port: 0, tls: 'pinned-private' }, 'safety.inbound.port'],
    ['port 65536', { port: 65536, tls: 'pinned-private' }, 'safety.inbound.port'],
    ['port as a string', { port: '8443', tls: 'pinned-private' }, 'safety.inbound.port'],
    ['port 8443.5', { port: 8443.5, tls: 'pinned-private' }, 'safety.inbound.port'],
    ['port NaN', { port: Number.NaN, tls: 'pinned-private' }, 'safety.inbound.port'],
    ['port true', { port: true, tls: 'pinned-private' }, 'safety.inbound.port'],
    ['missing port', { tls: 'pinned-private' }, 'safety.inbound.port'],
    ['missing tls', { port: 8443 }, 'safety.inbound.tls'],
    ['tls "plain"', { port: 8443, tls: 'plain' }, 'safety.inbound.tls'],
    ['tls "Pinned-Private"', { port: 8443, tls: 'Pinned-Private' }, 'safety.inbound.tls'],
    ['an extra host key', { ...VALID_INBOUND, host: '127.0.0.1' }, 'safety.inbound'],
    ['an extra address key', { ...VALID_INBOUND, address: '10.0.0.1' }, 'safety.inbound'],
    ['an extra keyFile key', { ...VALID_INBOUND, keyFile: '/etc/x.key' }, 'safety.inbound'],
    ['inbound null', null, 'safety.inbound'],
    ['inbound an array', [VALID_INBOUND], 'safety.inbound'],
    ['inbound a string', '8443', 'safety.inbound'],
  ];

  it.each(refusals)('refuses %s', (_label, inbound, field) => {
    expect(refusedField(withInbound(production, inbound))).toBe(field);
  });

  it('refuses a demo that names production with an inbound block', () => {
    expect(
      refusedField(
        withInbound(() => withVerdictSource(demoDescriptor, 'production'), VALID_INBOUND)
      )
    ).toBe('safety.verdictSource');
  });

  it('refuses a demo with an inbound block and no verdict source', () => {
    expect(refusedField(withInbound(demoDescriptor, VALID_INBOUND))).toBe('safety.inbound');
  });

  it('SABOTAGE — a validate.ts that lets inbound through without production is caught; the real one is not', async () => {
    const descriptor = withInbound(() => entryTenantDescriptor(), VALID_INBOUND);
    // RED: drop the inbound-needs-production rule.
    const sabotaged = await importSabotaged<{ validate: typeof ValidateFn }>(
      'validate.ts',
      (source) => {
        const target = "if (safety.verdictSource !== 'production') {";
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in validate.ts -- update the mutation');
        }
        return source.replace(target, 'if (false) {');
      }
    );
    expect(sabotaged.validate(descriptor, TEST_ZONES).safety.inbound).toEqual(VALID_INBOUND);

    // GREEN: the real one refuses it.
    expect(refusedField(descriptor)).toBe('safety.inbound');
  });

  it('SABOTAGE — a validate.ts without the port upper bound is caught; the real one is not', async () => {
    const descriptor = withInbound(production, { port: 65536, tls: 'pinned-private' });
    // RED: remove the upper bound, so 65536 is accepted.
    const sabotaged = await importSabotaged<{ validate: typeof ValidateFn }>(
      'validate.ts',
      (source) => {
        const target = 'port < 1 || port > 65535';
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in validate.ts -- update the mutation');
        }
        return source.replace(target, 'port < 1');
      }
    );
    expect(sabotaged.validate(descriptor, TEST_ZONES).safety.inbound).toEqual({
      port: 65536,
      tls: 'pinned-private',
    });

    // GREEN: the real one refuses it.
    expect(refusedField(descriptor)).toBe('safety.inbound.port');
  });

  it('SABOTAGE — an environment.ts that renders a key path beside the port is caught; the real one is not', async () => {
    const descriptor = validate(withInbound(production, VALID_INBOUND), TEST_ZONES);
    // RED: also render the host end's key file path into the environment.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const target = 'env.VERDICT_HOST_INBOUND_TLS = safety.inbound.tls;';
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in environment.ts -- update the mutation');
        }
        return source.replace(
          target,
          `${target}\n      env.VERDICT_HOST_TLS_KEY_FILE = '/var/lib/verdict-host/key.pem';`
        );
      }
    );
    expect(keyPathKeys(envOf(descriptor, sabotaged.tenantEnvironment))).toEqual([
      'VERDICT_HOST_TLS_KEY_FILE',
    ]);

    // GREEN: the real module renders no key or certificate path.
    expect(keyPathKeys(envOf(descriptor))).toEqual([]);
  });
});

describe('the verdict volume is read-only in Ghost', () => {
  it('SABOTAGE — a compose.ts that mounts it read-write is caught; the real one is not', async () => {
    const descriptor = validate(withVerdictSource(entryTenantDescriptor, 'production'), TEST_ZONES);
    const volume = `ghost-${descriptor.slug}-verdict`;
    const sabotagedCompose = await importSabotaged<typeof import('../src/compose.js')>(
      'compose.ts',
      (source) => {
        const target = '`${verdict}:${VERDICT_MOUNT_PATH}:ro`';
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in compose.ts -- update the mutation');
        }
        return source.replace(target, '`${verdict}:${VERDICT_MOUNT_PATH}`');
      }
    );
    const env = envOf(descriptor);
    const args = {
      kind: descriptor.kind,
      slug: descriptor.slug,
      uid: descriptor.uid,
      appHostPrivateIp: descriptor.appHostIp,
      ports: descriptor.ports,
      environment: env,
      limits: uploadLimits(),
      caps: descriptor.caps,
      dataMount: null,
      mailNetwork: null,
      verdictVolume: volume,
    };
    // RED: the read-write mount is rendered.
    expect(sabotagedCompose.renderComposeStack(args)).toContain(`'${volume}:${MOUNT_PATH}'`);
    // GREEN: the real module mounts it read-only only.
    const { renderComposeStack } = await import('../src/compose.js');
    const real = renderComposeStack(args);
    expect(real).toContain(`'${volume}:${MOUNT_PATH}:ro'`);
    expect(real).not.toContain(`'${volume}:${MOUNT_PATH}'`);
  });
});
