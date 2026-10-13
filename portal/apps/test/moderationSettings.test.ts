import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_CHECKS,
  ARTICLE_CHECKS,
  assertConfigurable,
  COMMENT_CHECKS,
  defaultSettings,
  FLOOR_CHECKS,
  InvalidModerationFormError,
  moderationBody,
  NotConfigurableError,
  parseModerationForm,
  parseTenantKind,
  renderFloorRow,
  renderModeration,
  renderSensitivity,
  renderToggle,
  saveModeration,
  SettingsNotAvailableError,
  UnrecognisedFieldError,
  type ModerationStore,
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

  it('renders an editable control for each comment check and a disabled one for each article check', () => {
    const html = renderModeration(REAL());
    for (const id of COMMENT_CHECKS) {
      expect(html).toContain(`name="comment.${id}.enabled"`);
      expect(html).toContain(`name="comment.${id}.sensitivity"`);
    }
    expect(html).toContain('name="article.article_check_a.enabled"');
    for (const element of controls(html).filter((tag) => /^<(input|select)\b/.test(tag))) {
      const article = element.includes('name="article.');
      expect(element.includes(' disabled')).toBe(article);
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
    expect(html).toMatch(/name="comment\.spam\.enabled" value="1">/);
  });

  it('says the defaults are not a decision until something is saved, and not after', () => {
    const html = renderModeration(REAL());
    expect(html).toContain('SETTINGS_NOT_YET_SAVED');
    expect(html).toContain('PLACEHOLDER_DEFAULTS_NOT_A_DECISION');
    expect(renderModeration({ ...REAL(), saved: true })).not.toContain('SETTINGS_NOT_YET_SAVED');
  });
});

describe('moderation page, one save form and no dead link', () => {
  it('has one form to the save route holding every comment control, and no link', () => {
    const body = renderModeration(REAL());
    expect(body.match(/<form\b/g)).toHaveLength(1);
    expect(body).toContain('<form method="post" action="/moderation/save">');
    const formBody = body.slice(body.indexOf('<form'), body.indexOf('</form>'));
    for (const id of COMMENT_CHECKS) {
      expect(formBody).toContain(`name="comment.${id}.enabled"`);
      expect(formBody).toContain(`name="comment.${id}.sensitivity"`);
    }
    expect(formBody).not.toContain('FLOOR_');
    expect(formBody).not.toContain('article.');
    expect(body.match(/<button\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/<a\b/);
    expect(body).not.toMatch(/\bhref=/);
  });

  it('has no form, submit control or link for a demo', () => {
    const body = renderModeration({
      kind: 'DEMO',
      settings: defaultSettings([]),
      articleChecks: [],
    });
    expect(body).not.toMatch(/<form\b/);
    expect(body).not.toMatch(/<button\b/);
    expect(body).not.toMatch(/<a\b/);
    expect(body).not.toMatch(/\baction=/);
    expect(body).not.toMatch(/\bhref=/);
  });

  it('no floor row or absolute check has an input, anywhere on the page', () => {
    const html = renderModeration(REAL());
    for (const id of [...FLOOR_CHECKS, 'media_hash']) {
      expect(html).not.toMatch(new RegExp(`<(input|select)[^>]*name="[^"]*${id}`));
    }
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
    expect(controls(html).every((tag) => !/^<a\b/.test(tag))).toBe(true);
  });

  it('lays what the tenant saved over the placeholder defaults, for a real tenant only', async () => {
    const load = async () => ({ spam: { enabled: false, sensitivity: 'high' as const } });
    const real = await moderationBody({}, async () => 'REAL', load);
    expect(real).toMatch(/name="comment\.spam\.enabled" value="1">/);
    expect(real).toContain('<option value="high" selected>');
    expect(real).not.toContain('SETTINGS_NOT_YET_SAVED');
    expect(real).toMatch(/name="comment\.harassment\.enabled" value="1" checked>/);
  });

  it('reads nothing from storage for a demo or an absent seam', async () => {
    let reads = 0;
    const load = async () => {
      reads += 1;
      return {};
    };
    await moderationBody({}, async () => 'DEMO', load);
    await moderationBody({}, undefined, load);
    expect(reads).toBe(0);
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
  it('keeps the storable comment checks disjoint from the floor and absolute checks', () => {
    // COMMENT_CHECKS also generates the table's constraint: a floor or absolute
    // id in it would become storable, so the lists must never overlap.
    const storable: readonly string[] = COMMENT_CHECKS;
    for (const id of [...FLOOR_CHECKS, ...ABSOLUTE_CHECKS]) {
      expect(storable).not.toContain(id);
    }
  });

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

describe('editable controls are built for a comment check only', () => {
  it('refuses an editable control for an article check or an unknown check', () => {
    expect(() => renderToggle('article', 'article_check_a', true, true)).toThrow(
      NotConfigurableError
    );
    expect(() => renderToggle('comment', 'not_a_check', true, true)).toThrow(NotConfigurableError);
    expect(() => renderSensitivity('threats' as never, 'low', true)).toThrow(NotConfigurableError);
    expect(() => renderSensitivity('not_a_check' as never, 'low', true)).toThrow(
      NotConfigurableError
    );
  });

  it('builds an editable comment control with no disabled attribute', () => {
    expect(renderToggle('comment', 'spam', true, true)).not.toContain('disabled');
    expect(renderSensitivity('spam', 'low', true)).not.toContain('disabled');
    expect(renderSensitivity('spam', 'low')).toContain('disabled');
  });
});

/** The form the page posts: a sensitivity for each check and an enabled for each that is on. */
const posted = (
  overrides: Record<string, string | null> = {},
  extra: [string, string][] = []
): URLSearchParams => {
  const form = new URLSearchParams();
  for (const id of COMMENT_CHECKS) {
    form.set(`comment.${id}.enabled`, '1');
    form.set(`comment.${id}.sensitivity`, 'medium');
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) form.delete(key);
    else form.set(key, value);
  }
  for (const [key, value] of extra) form.append(key, value);
  return form;
};

describe('parsing the posted form', () => {
  it('turns a full form into one setting per comment check', () => {
    const changes = parseModerationForm(
      posted({
        'comment.spam.enabled': null,
        'comment.spam.sensitivity': 'high',
        'comment.harassment.sensitivity': 'low',
      })
    );
    expect(changes.map((c) => c.check)).toEqual([...COMMENT_CHECKS]);
    expect(changes.find((c) => c.check === 'spam')).toEqual({
      check: 'spam',
      enabled: false,
      sensitivity: 'high',
    });
    expect(changes.find((c) => c.check === 'harassment')).toEqual({
      check: 'harassment',
      enabled: true,
      sensitivity: 'low',
    });
  });

  it.each([
    ['comment.threats.enabled', '1'],
    ['comment.threats.enabled', '0'],
    ['comment.threats.sensitivity', 'low'],
    ['comment.incitement.enabled', ''],
    ['comment.targeting_package.sensitivity', 'high'],
    ['comment.csam_text.enabled', '1'],
    ['comment.media_hash.enabled', '0'],
    ['comment.media_hash.sensitivity', 'low'],
    ['floor.threats.enabled', '0'],
    ['article.threats.enabled', '0'],
    ['threats', 'off'],
    ['media_hash', '0'],
    ['threats.enabled', '0'],
    ['comment.spam.threats', '1'],
  ])('refuses %j=%j as a floor or absolute check, with the typed error', (key, value) => {
    expect(() => parseModerationForm(posted({}, [[key, value]]))).toThrow(NotConfigurableError);
  });

  it('names the refused check on the error', () => {
    try {
      parseModerationForm(posted({}, [['comment.csam_text.enabled', '0']]));
      expect.unreachable('a floor check must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(NotConfigurableError);
      expect((error as NotConfigurableError).check).toBe('csam_text');
    }
  });

  it.each([
    ['comment.unknown.enabled'],
    ['comment.spam.other'],
    ['comment.spam'],
    ['article.article_check_a.enabled'],
    ['tenant_id'],
    ['comment..enabled'],
    ['comment.spam.enabled.x'],
    ['Comment.spam.enabled'],
  ])('refuses the unrecognised field %j', (key) => {
    expect(() => parseModerationForm(posted({}, [[key, '1']]))).toThrow(UnrecognisedFieldError);
  });

  it.each([
    ['a sensitivity outside the closed list', { 'comment.spam.sensitivity': 'off' }],
    ['an empty sensitivity', { 'comment.spam.sensitivity': '' }],
    ['a floor name as a sensitivity', { 'comment.spam.sensitivity': 'threats' }],
    ['an enabled that is not 1', { 'comment.spam.enabled': 'true' }],
    ['a check with no sensitivity', { 'comment.spam.sensitivity': null }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => parseModerationForm(posted(overrides))).toThrow(InvalidModerationFormError);
  });

  it('refuses a repeated field and an empty form', () => {
    expect(() => parseModerationForm(posted({}, [['comment.spam.sensitivity', 'low']]))).toThrow(
      InvalidModerationFormError
    );
    expect(() => parseModerationForm(new URLSearchParams())).toThrow(InvalidModerationFormError);
  });
});

describe('the save work', () => {
  const store = () => {
    const saved: unknown[] = [];
    const impl: ModerationStore<string> = {
      moderationSettings: async () => ({}),
      saveModerationSettings: async (scope, request, now) => {
        saved.push({ scope, request, now });
      },
    };
    return { impl, saved };
  };
  const NOW = new Date('2026-10-12T10:00:00Z');

  it('saves the parsed form for a real tenant, under the session identity', async () => {
    const { impl, saved } = store();
    await saveModeration({
      scope: 'scope-a',
      kindOf: async () => 'REAL',
      store: impl,
      updatedBy: 'user-a',
      form: posted({ 'comment.spam.enabled': null }),
      now: NOW,
    });
    expect(saved).toHaveLength(1);
    const call = saved[0] as { scope: string; request: { updatedBy: string; changes: unknown[] } };
    expect(call.scope).toBe('scope-a');
    expect(call.request.updatedBy).toBe('user-a');
    expect(call.request.changes).toHaveLength(COMMENT_CHECKS.length);
  });

  it.each([['DEMO'], ['demo'], ['PUBLISHER'], [''], [undefined]])(
    'refuses a save for the kind %j, and writes nothing',
    async (kind) => {
      const { impl, saved } = store();
      await expect(
        saveModeration({
          scope: 's',
          kindOf: async () => kind,
          store: impl,
          updatedBy: 'u',
          form: posted(),
          now: NOW,
        })
      ).rejects.toBeInstanceOf(SettingsNotAvailableError);
      expect(saved).toEqual([]);
    }
  );

  it('refuses a save when there is no kind seam', async () => {
    const { impl, saved } = store();
    await expect(
      saveModeration({
        scope: 's',
        kindOf: undefined,
        store: impl,
        updatedBy: 'u',
        form: posted(),
        now: NOW,
      })
    ).rejects.toBeInstanceOf(SettingsNotAvailableError);
    expect(saved).toEqual([]);
  });

  it('refuses a form that lowers a floor check, writing nothing, for a real tenant', async () => {
    const { impl, saved } = store();
    await expect(
      saveModeration({
        scope: 's',
        kindOf: async () => 'REAL',
        store: impl,
        updatedBy: 'u',
        form: posted({}, [['comment.threats.enabled', '0']]),
        now: NOW,
      })
    ).rejects.toBeInstanceOf(NotConfigurableError);
    expect(saved).toEqual([]);
  });
});
