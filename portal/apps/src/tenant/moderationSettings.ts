import { escapeHtml } from '../shell/html.js';

/**
 * The tenant moderation settings page, in three tiers. The absolute layer is
 * never shown; the mandatory floor is shown read-only with an appeal link; the
 * comment and article layers are configurable. A demo slot sees none of the
 * configurable layers. The tiers are fixed by the design, not by the page.
 */

/** Media hash matching: never a setting, never appealable, never shown. */
export const ABSOLUTE_CHECKS = ['media_hash'] as const;

/** Mandatory: the tenant cannot switch these off; each held item is appealable. */
export const FLOOR_CHECKS = ['threats', 'incitement', 'targeting_package', 'csam_text'] as const;

export const COMMENT_CHECKS = [
  'harassment',
  'spam',
  'sexual_content',
  'self_harm',
  'off_topic',
] as const;

export const SENSITIVITIES = ['low', 'medium', 'high'] as const;

export type CommentCheck = (typeof COMMENT_CHECKS)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];
export type TenantKind = 'REAL' | 'DEMO';

export interface CommentSetting {
  readonly enabled: boolean;
  readonly sensitivity: Sensitivity;
}

export interface ArticleSetting {
  readonly enabled: boolean;
}

export interface ModerationSettings {
  readonly comment: Readonly<Record<CommentCheck, CommentSetting>>;
  /** Keyed by article check id; the article check set is not yet ruled. */
  readonly article: Readonly<Record<string, ArticleSetting>>;
}

export interface ModerationView {
  readonly kind: TenantKind;
  readonly settings: ModerationSettings;
  readonly articleChecks: readonly string[];
}

export class NotConfigurableError extends Error {
  readonly check: string;

  constructor(check: string) {
    super(`check ${check} is not configurable`);
    this.name = 'NotConfigurableError';
    this.check = check;
  }
}

const NOT_CONFIGURABLE: ReadonlySet<string> = new Set<string>([
  ...ABSOLUTE_CHECKS,
  ...FLOOR_CHECKS,
]);

/** Refuses any check whose tier is absolute or mandatory floor. */
export function assertConfigurable(check: string): void {
  if (NOT_CONFIGURABLE.has(check)) throw new NotConfigurableError(check);
}

export function defaultSettings(articleChecks: readonly string[]): ModerationSettings {
  const comment = Object.fromEntries(
    COMMENT_CHECKS.map((id) => [id, { enabled: true, sensitivity: 'medium' as Sensitivity }])
  ) as Record<CommentCheck, CommentSetting>;
  const article = Object.fromEntries(articleChecks.map((id) => [id, { enabled: true }]));
  return { comment, article };
}

const checkedAttr = (on: boolean): string => (on ? ' checked' : '');

/** A configurable toggle. It is never built for a check in the absolute or floor tier. */
export function renderToggle(group: 'comment' | 'article', id: string, on: boolean): string {
  assertConfigurable(id);
  const name = escapeHtml(`${group}.${id}.enabled`);
  return `<label><input type="checkbox" name="${name}" value="1"${checkedAttr(on)}> ${escapeHtml(
    `${group.toUpperCase()}_LABEL_${id.toUpperCase()}`
  )}</label>`;
}

/** A mandatory floor check: read-only, with no input element, and an appeal link. */
export function renderFloorRow(id: string): string {
  if (!(FLOOR_CHECKS as readonly string[]).includes(id)) throw new NotConfigurableError(id);
  return `<li>${escapeHtml(`FLOOR_LABEL_${id.toUpperCase()}`)} <a href="/moderation/appeal">APPEAL_LINK</a></li>`;
}

function renderSensitivity(group: 'comment', id: CommentCheck, current: Sensitivity): string {
  assertConfigurable(id);
  const name = escapeHtml(`${group}.${id}.sensitivity`);
  const options = SENSITIVITIES.map(
    (level) =>
      `<option value="${level}"${level === current ? ' selected' : ''}>${escapeHtml(
        `SENSITIVITY_${level.toUpperCase()}`
      )}</option>`
  ).join('');
  return `<select name="${name}">${options}</select>`;
}

/** The moderation settings page body. Escaped markup, built from the view only. */
export function renderModeration(view: ModerationView): string {
  if (view.kind === 'DEMO') {
    return '<h1>MODERATION_TITLE</h1><p>DEMO_NO_MODERATION_SETTINGS</p>';
  }
  const floor = FLOOR_CHECKS.map(renderFloorRow).join('');
  const comments = COMMENT_CHECKS.map((id) => {
    const setting = view.settings.comment[id];
    return `<li>${renderToggle('comment', id, setting.enabled)} ${renderSensitivity(
      'comment',
      id,
      setting.sensitivity
    )}</li>`;
  }).join('');
  const articles = view.articleChecks
    .map((id) => {
      const setting = view.settings.article[id] ?? { enabled: false };
      return `<li>${renderToggle('article', id, setting.enabled)}</li>`;
    })
    .join('');
  return (
    '<h1>MODERATION_TITLE</h1>' +
    `<h2>FLOOR_HEADING</h2><ul>${floor}</ul>` +
    '<form method="post" action="/moderation/save">' +
    `<h2>COMMENT_HEADING</h2><ul>${comments}</ul>` +
    `<h2>ARTICLE_HEADING</h2><ul>${articles}</ul>` +
    '<button type="submit">SAVE_SETTINGS</button></form>'
  );
}
