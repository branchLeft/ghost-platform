/**
 * Real source-mutation sabotage for two controls that must be proven
 * against a mutated copy of the actual committed source, not a string
 * mutated inside the test: no-secret-in-output and determinism. Each test
 * here imports that mutated copy
 * (`test/helpers/sourceSabotage.ts#importSabotaged`), not a
 * re-implementation, and shows the mutation breaks something a real
 * regression in that source would also break.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { validate } from '../src/validate.js';
import type { render as RenderFn } from '../src/render.js';
import type { renderEdgeSiteBlock as RenderEdgeSiteBlockFn } from '../src/edge.js';
import type { tenantEnvironment as TenantEnvironmentFn } from '../src/environment.js';
import type { renderSettings as RenderSettingsFn } from '../src/settings.js';
import { TEST_ZONES, demoDescriptor, entryTenantDescriptor } from './fixtures.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';
import { assertQueueMailTimeouts } from './helpers/queueMailTimeouts.js';
import { uploadLimits } from '../src/runtime.js';
import { secretsEnvPath } from '../src/naming.js';

afterAll(() => {
  cleanupSabotageTmp();
});

describe('NO-SECRET-IN-OUTPUT — source-mutation sabotage', () => {
  it('a required() that returns a literal secret instead of a reference is caught; the real module is not', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);

    // RED: mutate environment.ts's actual `required()` function -- the one
    // place every secret-shaped value is supposed to become a
    // `${VAR:?...}` reference -- so it returns a literal value instead.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const target =
          'return `\\${${SECRET_ENV_KEYS[name]}:?set ${SECRET_ENV_KEYS[name]} in ${secretsFilePath}}`;';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in environment.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, "return 'hunter2';");
      }
    );
    const sabotagedEnv = sabotaged.tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(sabotagedEnv.database__connection__password).toBe('hunter2');
    expect(Object.values(sabotagedEnv)).toContain('hunter2');

    // GREEN: the real, unmutated module never does this.
    const { tenantEnvironment: realTenantEnvironment } = await import('../src/environment.js');
    const realEnv = realTenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(Object.values(realEnv)).not.toContain('hunter2');
    expect(realEnv.database__connection__password).toContain('${GHOST_DB_PASSWORD:?');
  });
});

describe('DECORATOR-PER-FEATURE — source-mutation sabotage', () => {
  it('dropping one storage feature from STORAGE_FEATURES silently leaves it unwrapped; the real module wraps all three', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);

    // RED: mutate environment.ts's actual STORAGE_FEATURES list so `files`
    // is dropped -- exactly the failure mode this control exists to catch: a
    // mechanism that renders the decorator for some storage features and
    // not others, silently, with every test for the ones it does cover
    // green.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const target = "const STORAGE_FEATURES = ['images', 'media', 'files'] as const;";
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in environment.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, "const STORAGE_FEATURES = ['images', 'media'] as const;");
      }
    );
    const sabotagedEnv = sabotaged.tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(sabotagedEnv).not.toHaveProperty('storage__files__adapter');
    expect(sabotagedEnv).not.toHaveProperty('storage__files__wraps');

    // GREEN: the real, unmutated module wraps every one of the three
    // storage features, `files` included.
    const { tenantEnvironment: realTenantEnvironment } = await import('../src/environment.js');
    const realEnv = realTenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(realEnv.storage__files__adapter).toBe('ScanningStorageAdapter');
    expect(realEnv.storage__files__wraps).toBe('S3Storage');
    expect(realEnv.storage__images__adapter).toBe('ScanningStorageAdapter');
    expect(realEnv.storage__media__adapter).toBe('ScanningStorageAdapter');
  });
});

describe('DETERMINISM — source-mutation sabotage', () => {
  it('an IMAGE line seeded from Math.random() is non-deterministic; the real module is not', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);

    // RED: mutate render.ts's actual `renderImageEnv` so it is no longer a
    // pure function of the descriptor.
    const sabotaged = await importSabotaged<{ render: typeof RenderFn }>('render.ts', (source) => {
      const target = 'return `IMAGE=${descriptor.image}\\n`;';
      if (!source.includes(target)) {
        throw new Error(
          'sabotage target string not found in render.ts -- update the mutation to match the current source'
        );
      }
      return source.replace(target, 'return `IMAGE=${descriptor.image}:${Math.random()}\\n`;');
    });
    const first = sabotaged
      .render(descriptor, TEST_ZONES)
      .find((a) => a.path === 'image.env')!.content;
    const second = sabotaged
      .render(descriptor, TEST_ZONES)
      .find((a) => a.path === 'image.env')!.content;
    expect(first).not.toBe(second);

    // GREEN: the real, unmutated module renders the same descriptor
    // identically every time.
    const { render: realRender } = await import('../src/render.js');
    const realFirst = realRender(descriptor, TEST_ZONES).find(
      (a) => a.path === 'image.env'
    )!.content;
    const realSecond = realRender(descriptor, TEST_ZONES).find(
      (a) => a.path === 'image.env'
    )!.content;
    expect(realFirst).toBe(realSecond);
  });
});

describe('MAIL-ADDRESS-CONSISTENCY — source-mutation sabotage', () => {
  it('members_support_address computed independently of mail__from can disagree; the real settings.ts never does', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);

    // RED: mutate settings.ts's actual `renderSettings` so
    // `members_support_address` is a hardcoded literal instead of the
    // shared `renderSendingAddress` call — reproducing the exact trap the
    // story names: the two keys computed independently, free to disagree.
    const sabotaged = await importSabotaged<{ renderSettings: typeof RenderSettingsFn }>(
      'settings.ts',
      (source) => {
        const target =
          'members_support_address: renderSendingAddress(descriptor.mail.identity, zones),';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in settings.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, "members_support_address: 'wrong@example.invalid',");
      }
    );
    const sabotagedSettings = sabotaged.renderSettings(descriptor, TEST_ZONES);
    const { tenantEnvironment: realTenantEnvironment } = await import('../src/environment.js');
    const realEnv = realTenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    // RED: the sabotaged setting disagrees with the real mail__from — the
    // exact magic-link trap the story names ("a test fails if they differ").
    expect(sabotagedSettings.members_support_address).not.toBe(realEnv.mail__from);

    // GREEN: the real, unmutated settings.ts always agrees with it.
    const { renderSettings: realRenderSettings } = await import('../src/settings.js');
    const realSettings = realRenderSettings(descriptor, TEST_ZONES);
    expect(realSettings.members_support_address).toBe(realEnv.mail__from);
  });
});

describe('QUEUE-MAIL-TIMEOUTS — source-mutation sabotage', () => {
  it('removing the explicit queue mail timeouts from environment.ts is caught; the real module renders them', async () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);

    // RED: mutate environment.ts's queue-with-mail branch so the three
    // explicit SMTP timeouts are no longer rendered -- the failure mode
    // where a frozen spool holds a reader's request for nodemailer's
    // multi-minute defaults.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const target =
          '      mail__options__connectionTimeout: MAIL_CONNECTION_TIMEOUT_MILLISECONDS,\n' +
          '      mail__options__greetingTimeout: MAIL_GREETING_TIMEOUT_MILLISECONDS,\n' +
          '      mail__options__socketTimeout: MAIL_SOCKET_TIMEOUT_MILLISECONDS,\n';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in environment.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, '');
      }
    );
    const sabotagedEnv = sabotaged.tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(() => assertQueueMailTimeouts(sabotagedEnv)).toThrow();

    // GREEN: the real, unmutated module renders all three timeouts.
    const { tenantEnvironment: realTenantEnvironment } = await import('../src/environment.js');
    const realEnv = realTenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(() => assertQueueMailTimeouts(realEnv)).not.toThrow();
  });
});

describe('DEMO-STRIPE-LIMIT — source-mutation sabotage', () => {
  const KEY = 'hostSettings__limits__limitStripeConnect__disabled';

  it('deleting the Stripe limit line from environment.ts leaves a demo without it; the real module renders it', async () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);

    // RED: delete the one line that spreads the demo-only key into the env.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const target = '    ...hostStripeEnvironment(descriptor.kind),\n';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in environment.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, '');
      }
    );
    const sabotagedEnv = sabotaged.tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(sabotagedEnv).not.toHaveProperty(KEY);

    // GREEN: the real, unmutated module renders it for the demo.
    const { tenantEnvironment: realTenantEnvironment } = await import('../src/environment.js');
    const realEnv = realTenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(realEnv[KEY]).toBe(true);
  });

  it('dropping the demo-only condition puts the key on a paying tenant; the real module keeps it off', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);

    // RED: make the condition always true, so a paying tenant is limited too.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const target = "return kind === 'demo' ? {";
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in environment.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, 'return true ? {');
      }
    );
    const sabotagedEnv = sabotaged.tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(sabotagedEnv[KEY]).toBe(true);

    // GREEN: the real, unmutated module renders nothing for a paying tenant.
    const { tenantEnvironment: realTenantEnvironment } = await import('../src/environment.js');
    const realEnv = realTenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(realEnv).not.toHaveProperty(KEY);
  });
});

describe('PAYMENTS-ALLOWANCE — source-mutation sabotage', () => {
  const themeCsp = { kind: 'computed', hashes: [] } as const;
  const stripe = { kind: 'stripe' } as const;
  const ORIGINS_LINE = 'const list = origins[directive] ?? [];';

  it('an edge.ts that drops the measured Stripe origins is caught: the paid header loses js.stripe.com; the real module keeps it', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);

    // RED: mutate the one line that reads the measured origins, so the paid
    // policy renders as if the allowance were empty -- the regression the live
    // checkout gate catches as a script-src-elem violation for
    // https://js.stripe.com on every page of a paid site.
    const sabotaged = await importSabotaged<{ renderEdgeSiteBlock: typeof RenderEdgeSiteBlockFn }>(
      'edge.ts',
      (source) => {
        if (!source.includes(ORIGINS_LINE)) {
          throw new Error(
            'sabotage target string not found in edge.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(ORIGINS_LINE, 'const list: string[] = [];');
      }
    );
    const sabotagedEdge = sabotaged.renderEdgeSiteBlock(
      descriptor,
      TEST_ZONES,
      uploadLimits(),
      themeCsp,
      stripe
    );
    expect(sabotagedEdge.contentSecurityPolicy).not.toContain('js.stripe.com');
    expect(sabotagedEdge.contentSecurityPolicy).not.toContain('frame-src');

    // GREEN: the real, unmutated module renders them.
    const { renderEdgeSiteBlock: realRenderEdgeSiteBlock } = await import('../src/edge.js');
    const realEdge = realRenderEdgeSiteBlock(
      descriptor,
      TEST_ZONES,
      uploadLimits(),
      themeCsp,
      stripe
    );
    expect(realEdge.contentSecurityPolicy).toContain('js.stripe.com');
    expect(realEdge.contentSecurityPolicy).toContain("frame-src 'self' https://js.stripe.com");
  });

  it('an edge.ts without the origin-shape check lets CSP syntax through the allowlist; the real module refuses it', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const smuggled =
      'const list = [...(origins[directive] ?? []), "https://x.example; script-src *"];';
    const injectOrigin = (source: string): string => {
      if (!source.includes(ORIGINS_LINE)) {
        throw new Error(
          'sabotage target string not found in edge.ts -- update the mutation to match the current source'
        );
      }
      return source.replace(ORIGINS_LINE, smuggled);
    };

    // RED: a smuggled origin with the shape check removed reaches the header.
    const unchecked = await importSabotaged<{ renderEdgeSiteBlock: typeof RenderEdgeSiteBlockFn }>(
      'edge.ts',
      (source) => {
        const check = 'if (!PAYMENT_ORIGIN_PATTERN.test(origin)) {';
        if (!source.includes(check)) {
          throw new Error(
            'sabotage target string not found in edge.ts -- update the mutation to match the current source'
          );
        }
        return injectOrigin(source).replace(check, 'if (false) {');
      }
    );
    expect(
      unchecked.renderEdgeSiteBlock(descriptor, TEST_ZONES, uploadLimits(), themeCsp, stripe)
        .contentSecurityPolicy
    ).toContain('script-src *');

    // GREEN: the same smuggled origin against the real shape check is refused.
    const checked = await importSabotaged<{ renderEdgeSiteBlock: typeof RenderEdgeSiteBlockFn }>(
      'edge.ts',
      injectOrigin
    );
    expect(() =>
      checked.renderEdgeSiteBlock(descriptor, TEST_ZONES, uploadLimits(), themeCsp, stripe)
    ).toThrow(/bare https origin/);
  });
});
