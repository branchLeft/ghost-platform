import { describe, expect, it } from 'vitest';
import {
  assertConfigurable,
  COMMENT_CHECKS,
  defaultSettings,
  FLOOR_CHECKS,
  NotConfigurableError,
  renderFloorRow,
  renderModeration,
  renderToggle,
} from '../src/tenant/moderationSettings.js';

const ARTICLES = ['article_check_a'];

describe('moderation settings page', () => {
  it('shows the floor read-only, with no input element for any floor check', () => {
    const html = renderModeration({
      kind: 'REAL',
      settings: defaultSettings(ARTICLES),
      articleChecks: ARTICLES,
    });
    for (const id of FLOOR_CHECKS) {
      expect(html).toContain(`FLOOR_LABEL_${id.toUpperCase()}`);
      expect(html).not.toContain(`name="${id}`);
    }
    expect(html).toContain('href="/moderation/appeal"');
  });

  it('never shows anything for the absolute floor', () => {
    const html = renderModeration({
      kind: 'REAL',
      settings: defaultSettings(ARTICLES),
      articleChecks: ARTICLES,
    });
    expect(html).not.toContain('media_hash');
    expect(html).not.toContain('MEDIA_HASH');
  });

  it('renders a toggle and a sensitivity for each comment check, reflecting the stored value', () => {
    const settings = defaultSettings(ARTICLES);
    const html = renderModeration({ kind: 'REAL', settings, articleChecks: ARTICLES });
    for (const id of COMMENT_CHECKS) {
      expect(html).toContain(`name="comment.${id}.enabled"`);
      expect(html).toContain(`name="comment.${id}.sensitivity"`);
    }
    const off = {
      ...settings,
      comment: { ...settings.comment, spam: { enabled: false, sensitivity: 'high' as const } },
    };
    const offHtml = renderModeration({ kind: 'REAL', settings: off, articleChecks: ARTICLES });
    expect(offHtml).toContain('<option value="high" selected>');
    expect(offHtml).toMatch(/name="comment\.spam\.enabled" value="1">/);
  });

  it('renders an on/off toggle for each article check, advisory and never holding publication', () => {
    const html = renderModeration({
      kind: 'REAL',
      settings: defaultSettings(ARTICLES),
      articleChecks: ARTICLES,
    });
    expect(html).toContain('name="article.article_check_a.enabled"');
  });

  it('renders no configurable layer for a demo slot, only the placeholder notice', () => {
    const html = renderModeration({
      kind: 'DEMO',
      settings: defaultSettings(ARTICLES),
      articleChecks: ARTICLES,
    });
    expect(html).toContain('DEMO_NO_MODERATION_SETTINGS');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('FLOOR_HEADING');
  });

  it('refuses to build a toggle for any absolute or floor check (control case)', () => {
    for (const id of [...FLOOR_CHECKS, 'media_hash']) {
      expect(() => renderToggle('comment', id, true)).toThrow(NotConfigurableError);
      expect(() => renderToggle('article', id, true)).toThrow(NotConfigurableError);
      expect(() => assertConfigurable(id)).toThrow(NotConfigurableError);
    }
  });

  it('refuses a floor check passed as an article check, so the page cannot be built with one', () => {
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
