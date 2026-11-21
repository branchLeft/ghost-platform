import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import { createFixture, ORG_A, ORG_B, TENANT_A, type Fixture } from '../../data/test/helpers.js';
import { ConfigError } from '../src/shell/config.js';
import { parseAllowPlaceholderCopy } from '../src/tenant/config.js';
import {
  blockGaps,
  createThirdPartyOff,
  isUnfilled,
  lineGaps,
  routeOf,
  THIRD_PARTY_OFF_COPY,
  withheldLine,
  type ThirdPartyOffCopy,
} from '../src/tenant/thirdPartyOff.js';
import { serve, type Running } from './browser.js';
import * as essentials from './promotionRig.js';
import * as site from './tenantSiteRig.js';

const PLACEHOLDER_SLOTS = [
  'THIRD_PARTY_OFF_HEADING',
  'THIRD_PARTY_OFF_BODY',
  'THIRD_PARTY_OFF_ONBOARDING_LINE',
];

// Test text only: stands in for the owner's prose, which this repository does not hold.
const FILLED: ThirdPartyOffCopy = {
  heading: 'Test heading',
  body: 'Test body with <markup> & "quotes".',
  linkLabel: 'Test link label',
  onboardingLine: 'Test onboarding line',
  requestRoute: '/support',
};

describe('what counts as an unfilled slot', () => {
  it.each(['', '   ', 'THIRD_PARTY_OFF_BODY', 'SOME WORDS IN CAPITALS', 'X1_Y2'])(
    'treats %j as unfilled',
    (value) => expect(isUnfilled(value)).toBe(true)
  );

  it.each(['Switched off.', 'a', 'Ça marche', '日本語', 'Off by default (FirstPromoter)'])(
    'treats %j as filled',
    (value) => expect(isUnfilled(value)).toBe(false)
  );

  it('ships every slot as its own placeholder and the request route empty', () => {
    expect(THIRD_PARTY_OFF_COPY).toEqual({
      heading: 'THIRD_PARTY_OFF_HEADING',
      body: 'THIRD_PARTY_OFF_BODY',
      linkLabel: 'THIRD_PARTY_OFF_LINK_LABEL',
      onboardingLine: 'THIRD_PARTY_OFF_ONBOARDING_LINE',
      requestRoute: '',
    });
    expect(blockGaps(THIRD_PARTY_OFF_COPY)).toEqual([
      'THIRD_PARTY_OFF_HEADING',
      'THIRD_PARTY_OFF_BODY',
    ]);
    expect(lineGaps(THIRD_PARTY_OFF_COPY)).toEqual(['THIRD_PARTY_OFF_ONBOARDING_LINE']);
  });
});

describe('what counts as a request route', () => {
  it.each(['/support', '/a/b?c=d', 'https://example.test/ask', 'mailto:ask@example.test'])(
    'accepts %s',
    (value) => expect(routeOf(value)).toBe(value)
  );

  it.each([
    '',
    'THIRD_PARTY_OFF_REQUEST_ROUTE',
    '//other.example.test',
    'javascript:alert(1)',
    'http://example.test',
    '/a b',
    '/a\\b',
    'data:text/html,x',
  ])('refuses %j', (value) => expect(routeOf(value)).toBeUndefined());
});

describe('the block and the line, by themselves', () => {
  it('leave out every unfilled slot unless placeholders are allowed', () => {
    const refusing = createThirdPartyOff();
    expect(refusing.block()).toBe('');
    expect(refusing.onboardingLine()).toBe('');
  });

  it('show the placeholders where they are allowed, with the label as text while there is no route', () => {
    const allowing = createThirdPartyOff({ allowPlaceholders: true });
    const block = allowing.block();
    for (const slot of [
      'THIRD_PARTY_OFF_HEADING',
      'THIRD_PARTY_OFF_BODY',
      'THIRD_PARTY_OFF_LINK_LABEL',
    ]) {
      expect(block).toContain(slot);
    }
    expect(block).not.toContain('<a ');
    expect(allowing.onboardingLine()).toContain('THIRD_PARTY_OFF_ONBOARDING_LINE');
  });

  it('show filled copy escaped, with the link, wherever the portal runs', () => {
    const filled = createThirdPartyOff({ copy: FILLED });
    const block = filled.block();
    expect(block).toContain('<h2>Test heading</h2>');
    expect(block).toContain('Test body with &lt;markup&gt; &amp; &quot;quotes&quot;.');
    expect(block).toContain('<a href="/support">Test link label</a>');
    expect(filled.onboardingLine()).toContain('Test onboarding line');
  });

  it('show filled copy with no link while the route is empty, and without its label', () => {
    const block = createThirdPartyOff({ copy: { ...FILLED, requestRoute: '' } }).block();
    expect(block).toContain('Test heading');
    expect(block).not.toContain('<a ');
    expect(block).not.toContain('Test link label');
  });

  it('refuse the block when one slot of it is a placeholder, whatever the others hold', () => {
    for (const broken of [
      { heading: 'THIRD_PARTY_OFF_HEADING' },
      { body: '' },
      { linkLabel: 'THIRD_PARTY_OFF_LINK_LABEL' },
      { requestRoute: 'javascript:alert(1)' },
      { requestRoute: 'THIRD_PARTY_OFF_REQUEST_ROUTE' },
    ]) {
      expect(createThirdPartyOff({ copy: { ...FILLED, ...broken } }).block(), String(broken)).toBe(
        ''
      );
    }
  });

  it('refuse the line when it is a placeholder, and the block when only the line is filled', () => {
    const lineOnly = { ...THIRD_PARTY_OFF_COPY, onboardingLine: 'Test onboarding line' };
    const refusing = createThirdPartyOff({ copy: lineOnly });
    expect(refusing.block()).toBe('');
    expect(refusing.onboardingLine()).toContain('Test onboarding line');
    expect(createThirdPartyOff({ copy: { ...FILLED, onboardingLine: '' } }).onboardingLine()).toBe(
      ''
    );
  });

  it('names what is withheld by slot, never by value', () => {
    expect(JSON.parse(withheldLine() ?? '{}')).toEqual({
      event: 'portal.copy_withheld',
      slots: ['THIRD_PARTY_OFF_HEADING', 'THIRD_PARTY_OFF_BODY', 'THIRD_PARTY_OFF_ONBOARDING_LINE'],
    });
    expect(withheldLine(FILLED)).toBeUndefined();
  });
});

describe('PORTAL_ALLOW_PLACEHOLDER_COPY', () => {
  it('is off when unset, empty or 0, on only for 1, and stops the process for anything else', () => {
    expect(parseAllowPlaceholderCopy(undefined)).toBe(false);
    expect(parseAllowPlaceholderCopy('')).toBe(false);
    expect(parseAllowPlaceholderCopy('0')).toBe(false);
    expect(parseAllowPlaceholderCopy('1')).toBe(true);
    for (const value of ['true', 'yes', ' 1', '2']) {
      expect(() => parseAllowPlaceholderCopy(value), value).toThrow(ConfigError);
    }
  });
});

describe('the site screen', () => {
  let mock: site.RunningMock;
  let refusing: Running;
  let allowing: Running;
  let filled: Running;

  beforeAll(async () => {
    mock = await site.startMock();
    await site.promote(mock, TENANT_A, site.CREDENTIAL_A);
    const settings = site.settingsFor(mock.baseUrl);
    refusing = await serve((origin) => site.portalOn(origin, settings));
    allowing = await serve((origin) =>
      site.portalOn(origin, settings, { allowPlaceholderCopy: true })
    );
    filled = await serve((origin) =>
      site.portalOn(origin, settings, { thirdPartyOffCopy: FILLED })
    );
  });

  afterAll(async () => {
    await Promise.all([refusing.close(), allowing.close(), filled.close()]);
    await mock.close();
  });

  it('shows no block to a tenant while the copy is unfilled, and still shows the site', async () => {
    const page = await (await site.signedIn(refusing.origin, ORG_A)).request('/site');
    expect(page.status).toBe(200);
    expect(page.body).toContain('SITE_TITLE');
    expect(page.body).not.toContain('data-slot="third-party-off"');
    expect(page.body).not.toContain('THIRD_PARTY_OFF');
  });

  it('shows the placeholders on a portal that allows them', async () => {
    const page = await (await site.signedIn(allowing.origin, ORG_A)).request('/site');
    expect(page.body).toContain('data-slot="third-party-off"');
    for (const slot of ['THIRD_PARTY_OFF_HEADING', 'THIRD_PARTY_OFF_BODY']) {
      expect(page.body).toContain(slot);
    }
  });

  it('shows filled copy and its link without any allowance', async () => {
    const page = await (await site.signedIn(filled.origin, ORG_A)).request('/site');
    expect(page.body).toContain('<h2>Test heading</h2>');
    expect(page.body).toContain('<a href="/support">Test link label</a>');
  });
});

describe('the Essentials request screen', () => {
  let fixture: Fixture;
  let mock: essentials.RunningMock;
  let refusing: Running;
  let allowing: Running;
  let filled: Running;
  const errors: string[] = [];

  beforeAll(async () => {
    fixture = await createFixture();
    const db = new TenantDb(fixture.tenant);
    mock = await essentials.startMock();
    const provisioning = essentials.settingsFor(mock.baseUrl);
    refusing = await serve((origin) => essentials.portalOn(origin, db, { provisioning }, errors));
    allowing = await serve((origin) =>
      essentials.portalOn(origin, db, { provisioning, allowPlaceholderCopy: true }, errors)
    );
    filled = await serve((origin) =>
      essentials.portalOn(origin, db, { provisioning, thirdPartyOffCopy: FILLED }, errors)
    );
  });

  afterAll(async () => {
    await Promise.all([refusing.close(), allowing.close(), filled.close()]);
    await mock.close();
    await fixture.close();
  });

  it('carries no line while the copy is unfilled, and still the form', async () => {
    const page = await (await essentials.signedIn(refusing.origin, ORG_B)).request('/essentials');
    expect(page.body).toContain('REQUEST_ESSENTIALS');
    expect(page.body).not.toContain('third-party-off');
    expect(page.body).not.toContain('THIRD_PARTY_OFF');
  });

  it('carries the placeholder line on a portal that allows it', async () => {
    const page = await (await essentials.signedIn(allowing.origin, ORG_B)).request('/essentials');
    expect(page.body).toContain('data-slot="third-party-off-onboarding"');
    expect(page.body).toContain(PLACEHOLDER_SLOTS[2]);
  });

  it('carries filled copy without any allowance', async () => {
    const page = await (await essentials.signedIn(filled.origin, ORG_B)).request('/essentials');
    expect(page.body).toContain(
      '<p data-slot="third-party-off-onboarding">Test onboarding line</p>'
    );
  });

  it('logs no error for any of it', () => {
    expect(errors).toEqual([]);
  });
});
