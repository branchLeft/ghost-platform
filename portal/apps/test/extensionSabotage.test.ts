import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as real from '../src/frontdoor/extensionPage.js';
import { FIELDS } from '../src/frontdoor/extensionPage.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';

type PageModule = typeof real;

const SOURCE = 'frontdoor/extensionPage.ts';
const CONSENT_GATE =
  "if (posted[FIELDS.consent] !== 'yes') return { ok: false, field: 'consent' };";

const NO_CONSENT = {
  [FIELDS.stillEvaluating]: 'EVALUATING_ANSWER',
  [FIELDS.audienceSize]: 'audience-small',
  [FIELDS.chargesReaders]: 'no',
  [FIELDS.moveWhen]: 'move-soon',
};

beforeAll(clearMutants);
afterAll(clearMutants);

describe('sabotage: the extension form without its consent gate', () => {
  it('refuses a mutation whose target is not in the module', async () => {
    await expect(
      importSabotaged<PageModule>('ext-missing', 'no such text', 'x', SOURCE)
    ).rejects.toThrow(/exactly once/);
  });

  it('holds with the real module: a form with no consent is refused naming consent', () => {
    expect(real.parseExtensionForm(NO_CONSENT)).toEqual({ ok: false, field: 'consent' });
  });

  it('with the gate removed, a form with no consent is read as a request: the refusal tests would be red', async () => {
    const mutant = await importSabotaged<PageModule>('ext-no-gate', CONSENT_GATE, '', SOURCE);
    const parsed = mutant.parseExtensionForm(NO_CONSENT);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.answers.consent).toBe(true);
  });
});
