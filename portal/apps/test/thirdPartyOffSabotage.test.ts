import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createThirdPartyOff,
  THIRD_PARTY_OFF_COPY,
  type ThirdPartyOffOptions,
  type ThirdPartyOff,
} from '../src/tenant/thirdPartyOff.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';

interface ThirdPartyOffModule {
  readonly createThirdPartyOff: (options?: ThirdPartyOffOptions) => ThirdPartyOff;
}

const FILE = 'tenant/thirdPartyOff.ts';

beforeAll(clearMutants);
afterAll(clearMutants);

/** What a tenant would be shown by a portal that does not allow placeholders, with the owner's copy still unfilled. */
function shownToATenant(create: ThirdPartyOffModule['createThirdPartyOff']): string {
  const off = create({ copy: THIRD_PARTY_OFF_COPY, allowPlaceholders: false });
  return off.block() + off.onboardingLine();
}

describe('sabotage: an unfilled placeholder is never shown to a tenant', () => {
  it('the helper refuses a mutation that changes nothing', async () => {
    await expect(
      importSabotaged('third-party-noop', 'text that is not in the module', 'x', FILE)
    ).rejects.toThrow('exactly once');
  });

  it('RED: a block that skips its guard shows the heading and body placeholders', async () => {
    const broken = await importSabotaged<ThirdPartyOffModule>(
      'third-party-block-unguarded',
      "if (blockGaps(copy).length > 0 && !allow) return '';",
      '',
      FILE
    );
    const shown = shownToATenant(broken.createThirdPartyOff);
    expect(shown).toContain('THIRD_PARTY_OFF_HEADING');
    expect(shown).toContain('THIRD_PARTY_OFF_BODY');
  });

  it('RED: a line that skips its guard shows the onboarding placeholder', async () => {
    const broken = await importSabotaged<ThirdPartyOffModule>(
      'third-party-line-unguarded',
      "if (lineGaps(copy).length > 0 && !allow) return '';",
      '',
      FILE
    );
    expect(shownToATenant(broken.createThirdPartyOff)).toContain('THIRD_PARTY_OFF_ONBOARDING_LINE');
  });

  it('RED: a guard that takes a placeholder for prose shows it too', async () => {
    const broken = await importSabotaged<ThirdPartyOffModule>(
      'third-party-placeholder-is-prose',
      "return text === '' || PLACEHOLDER.test(text);",
      'return false;',
      FILE
    );
    expect(shownToATenant(broken.createThirdPartyOff)).toContain('THIRD_PARTY_OFF_HEADING');
  });

  it('GREEN: the real module shows a tenant nothing while the copy is unfilled', () => {
    expect(shownToATenant(createThirdPartyOff)).toBe('');
  });
});
