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
import type { tenantEnvironment as TenantEnvironmentFn } from '../src/environment.js';
import type { renderSettings as RenderSettingsFn } from '../src/settings.js';
import { TEST_ZONES, entryTenantDescriptor } from './fixtures.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';
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
