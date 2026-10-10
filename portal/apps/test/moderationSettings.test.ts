import { describe, expect, it } from 'vitest';
import {
  ARTICLE_CHECKS,
  assertConfigurable,
  COMMENT_CHECKS,
  defaultSettings,
  FLOOR_CHECKS,
  moderationBody,
  NotConfigurableError,
  parseTenantKind,
  renderFloorRow,
  renderModeration,
  renderToggle,
} from '../src/tenant/moderationSettings.js';

const ARTICLES = ['article_check_a'];
const REAL = (articleChecks: readonly string[] = ARTICLES) => ({
  kind: 'REAL',
  settings: defaultSettings(articleChecks),
  articleChecks,
});

/** Every element that can take input or act, and every link, in a body. */
const controls = (html: string): string[] =>
  html.match(/<(input|select|button|form|a)\b[^>]*>/g) ?? [];

describe('moderation page, configurable tiers', () => {
  it('shows the floor read-only, with no input element for any floor check', () => {
    const html = renderModeration(REAL());
    for (const id of FLOOR_CHECKS) {
      expect(html).toContain(`FLOOR_LABEL_${id.toUpperCase()}`);
      expect(html).not.toContain(`name="${id}`);
    }
  });

  it('never shows anything for the absolute floor', () => {
    const html = renderModeration(REAL());
    expect(html).not.toContain('media_hash');
    expect(html).not.toContain('MEDIA_HASH');
  });

  it('renders a control for each comment check and each article check, every one disabled', () => {
    const html = renderModeration(REAL());
    for (const id of COMMENT_CHECKS) {
      expect(html).toContain(`name="comment.${id}.enabled"`);
      expect(html).toContain(`name="comment.${id}.sensitivity"`);
    }
    expect(html).toContain('name="article.article_check_a.enabled"');
    for (const element of controls(html).filter((tag) => /^<(input|select)\b/.test(tag))) {
      expect(element).toContain(' disabled');
    }
  });

  it('reflects the stored value of a comment check', () => {
    const settings = defaultSettings(ARTICLES);
    const off = {
      ...settings,
      comment: { ...settings.comment, spam: { enabled: false, sensitivity: 'high' as const } },
    };
    const html = renderModeration({ kind: 'REAL', settings: off, articleChecks: ARTICLES });
    expect(html).toContain('<option value="high" selected>');
    expect(html).toMatch(/name="comment\.spam\.enabled" value="1" disabled>/);
  });

  it('says plainly that nothing is saved and that the defaults are not a decision', () => {
    const html = renderModeration(REAL());
    expect(html).toContain('SETTINGS_NOT_YET_SAVED');
    expect(html).toContain('PLACEHOLDER_DEFAULTS_NOT_A_DECISION');
  });
});

describe('moderation page, no actionable form and no dead link', () => {
  it('has no form, submit control or link, for any tenant', () => {
    for (const body of [
      renderModeration(REAL()),
      renderModeration({ kind: 'DEMO', settings: defaultSettings([]), articleChecks: [] }),
    ]) {
      expect(body).not.toMatch(/<form\b/);
      expect(body).not.toMatch(/<button\b/);
      expect(body).not.toMatch(/<a\b/);
      expect(body).not.toMatch(/\baction=/);
      expect(body).not.toMatch(/\bhref=/);
    }
  });

  it('every input and select is disabled', () => {
    const html = renderModeration(REAL());
    const fields = controls(html).filter((tag) => /^<(input|select)\b/.test(tag));
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(field).toContain(' disabled');
  });
});

describe('moderation page, demo', () => {
  it('renders only the notice for a demo slot', () => {
    const html = renderModeration({
      kind: 'DEMO',
      settings: defaultSettings(ARTICLES),
      articleChecks: ARTICLES,
    });
    expect(html).toContain('DEMO_NO_MODERATION_SETTINGS');
    expect(controls(html)).toEqual([]);
    expect(html).not.toContain('FLOOR_HEADING');
  });
});

describe('the tenant kind is closed', () => {
  it('accepts exactly REAL and DEMO', () => {
    expect(parseTenantKind('REAL')).toBe('REAL');
    expect(parseTenantKind('DEMO')).toBe('DEMO');
  });

  it.each([
    ['PUBLISHER'],
    ['demo'],
    ['real'],
    ['Real'],
    [' REAL'],
    ['REAL '],
    [''],
    ['null'],
    [undefined],
    [null],
    [0],
    [true],
    [{ kind: 'REAL' }],
    [['REAL']],
  ])('treats %j as a demo, which renders the notice and no controls', (value) => {
    expect(parseTenantKind(value)).toBe('DEMO');
    const html = renderModeration({
      kind: value,
      settings: defaultSettings(ARTICLES),
      articleChecks: ARTICLES,
    });
    expect(html).toContain('DEMO_NO_MODERATION_SETTINGS');
    expect(controls(html)).toEqual([]);
  });
});

describe('moderationBody, the route body', () => {
  it('is a demo when no seam is given', async () => {
    const html = await moderationBody({}, undefined);
    expect(html).toContain('DEMO_NO_MODERATION_SETTINGS');
  });

  it('is the configurable page only when the seam returns REAL', async () => {
    const html = await moderationBody({}, async () => 'REAL');
    expect(html).toContain('FLOOR_HEADING');
    expect(html).toContain('name="comment.spam.enabled"');
    expect(controls(html).every((tag) => !/^<(form|button|a)\b/.test(tag))).toBe(true);
  });

  it.each([['demo'], ['PUBLISHER'], [''], [undefined]])(
    'is a demo when the seam returns %j',
    async (value) => {
      const html = await moderationBody({}, async () => value);
      expect(html).toContain('DEMO_NO_MODERATION_SETTINGS');
    }
  );

  it('passes the scope to the seam', async () => {
    const seen: unknown[] = [];
    await moderationBody('scope-a', async (scope) => {
      seen.push(scope);
      return 'REAL';
    });
    expect(seen).toEqual(['scope-a']);
  });

  it('uses the article checks as configured, empty until ruled', () => {
    expect(ARTICLE_CHECKS).toEqual([]);
  });
});

describe('the guard against configuring the floor (control case)', () => {
  it('refuses to build a toggle for any absolute or floor check', () => {
    for (const id of [...FLOOR_CHECKS, 'media_hash']) {
      expect(() => renderToggle('comment', id, true)).toThrow(NotConfigurableError);
      expect(() => renderToggle('article', id, true)).toThrow(NotConfigurableError);
      expect(() => assertConfigurable(id)).toThrow(NotConfigurableError);
    }
  });

  it('refuses a floor check passed as an article check', () => {
    expect(() =>
      renderModeration({
        kind: 'REAL',
        settings: defaultSettings(['threats']),
        articleChecks: ['threats'],
      })
    ).toThrow(NotConfigurableError);
  });

  it('refuses a non-floor id in the floor row', () => {
    expect(() => renderFloorRow('harassment')).toThrow(NotConfigurableError);
    expect(renderFloorRow('threats')).toContain('FLOOR_LABEL_THREATS');
  });

  it('escapes any label built from an id', () => {
    expect(renderToggle('article', 'a"b', true)).not.toContain('a"b');
  });
});
