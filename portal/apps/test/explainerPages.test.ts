import { describe, expect, it } from 'vitest';
import { InvalidTenantKindError } from 'ghost-platform-portal-data/tenant';
import {
  EXPLAINER_SECTIONS,
  explainerLinks,
  FAQ_ENTRIES,
  faqEntriesFor,
  payingOnlyBody,
  renderExplainerPage,
  renderFaqPage,
} from '../src/tenant/explainerPages.js';
import { entryFor, SUPPORT_SCREENS } from '../src/tenant/supportScreens.js';

/** The text a reader sees: every tag removed, then split into words. */
const wordsOf = (html: string): string[] =>
  html
    .replace(/<[^>]*>/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);

const ALL_CAPS = /^[A-Z0-9_]+$/;

describe('the explainer page', () => {
  it('has one section per structural slot, each with a heading and a placeholder body', () => {
    expect(EXPLAINER_SECTIONS.length).toBeGreaterThanOrEqual(5);
    for (const section of EXPLAINER_SECTIONS) {
      expect(section.heading).toMatch(ALL_CAPS);
      expect(section.body).toMatch(ALL_CAPS);
    }
  });

  it('shows only ALL_CAPS placeholder words, so no prose is shipped', () => {
    const words = wordsOf(renderExplainerPage());
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) expect(word).toMatch(ALL_CAPS);
  });

  it('names what each body placeholder must cover', () => {
    for (const section of EXPLAINER_SECTIONS) {
      expect(section.body).toMatch(/_COVERS_/);
    }
  });
});

describe('the FAQ page', () => {
  it('routes every entry to a support form or a self-service page of the portal', () => {
    const selfService = new Set(['/documents', '/moderation']);
    const supportPaths = new Set(SUPPORT_SCREENS.map((entry) => entry.pagePath));
    for (const entry of FAQ_ENTRIES) {
      const href =
        entry.route.kind === 'SUPPORT' ? entryFor(entry.route.screen).pagePath : entry.route.href;
      expect(selfService.has(href) || supportPaths.has(href)).toBe(true);
    }
  });

  it('drops the support-routed entries when support is off, and keeps the self-service ones', () => {
    const off = faqEntriesFor(false);
    expect(off.every((entry) => entry.route.kind === 'SELF_SERVICE')).toBe(true);
    expect(off.length).toBeGreaterThan(0);
    expect(faqEntriesFor(true)).toEqual(FAQ_ENTRIES);
  });

  it('links each entry to its route and shows only ALL_CAPS placeholder words', () => {
    const page = renderFaqPage(true);
    for (const entry of FAQ_ENTRIES) {
      expect(page).toContain(`${entry.id}_QUESTION`);
      expect(page).toContain(`${entry.id}_ANSWER_COVERS_THE_ROUTE_TAKEN`);
      expect(page).toContain(`${entry.id}_ROUTE_LABEL`);
    }
    for (const word of wordsOf(page)) expect(word).toMatch(ALL_CAPS);
  });

  it('carries no support link when support is off', () => {
    const page = renderFaqPage(false);
    expect(page).not.toContain('/support');
    for (const word of wordsOf(page)) expect(word).toMatch(ALL_CAPS);
  });
});

describe('the paying-tenant gate on the explainer and the FAQ', () => {
  const scope = { tenant: 'scope-a' };

  it('gives a REAL tenant the page', async () => {
    const body = await payingOnlyBody(scope, async () => 'REAL', renderExplainerPage);
    expect(body).toBe(renderExplainerPage());
  });

  it('gives a DEMO slot the placeholder notice and none of the content', async () => {
    const body = await payingOnlyBody(scope, async () => 'DEMO', renderExplainerPage);
    expect(body).toBe('<h1>DEMO_NO_EXPLAINER</h1>');
    expect(body).not.toContain('EXPLAINER_PLATFORM_HEADING');
  });

  it.each([[undefined], ['real'], ['Real'], [''], [null], ['PUBLISHER']])(
    'refuses the kind %j: the page fails, with no content and no demo notice',
    async (value) => {
      await expect(
        payingOnlyBody(scope, async () => value, renderExplainerPage)
      ).rejects.toBeInstanceOf(InvalidTenantKindError);
    }
  );

  it('links the explainer and the FAQ from the landing only for a REAL tenant', () => {
    expect(explainerLinks('REAL')).toContain('href="/explainer"');
    expect(explainerLinks('REAL')).toContain('href="/faq"');
    expect(explainerLinks('DEMO')).toBe('');
    expect(explainerLinks(undefined)).toBe('');
  });
});
