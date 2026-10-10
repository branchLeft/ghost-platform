import { escapeHtml } from '../shell/html.js';

/**
 * The tenant moderation settings page, in three tiers. The absolute layer is
 * never shown; the mandatory floor is shown read-only; the comment and article
 * layers are configurable in the design. A demo slot sees none of the
 * configurable layers. Nothing is saved yet, so every control is disabled and
 * the page says so.
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

/** The article check set is an owner decision that has not been made: empty. */
export const ARTICLE_CHECKS: readonly string[] = [];

export const TENANT_KINDS = ['REAL', 'DEMO'] as const;

export type CommentCheck = (typeof COMMENT_CHECKS)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];
export type TenantKind = (typeof TENANT_KINDS)[number];

export interface CommentSetting {
  readonly enabled: boolean;
  readonly sensitivity: Sensitivity;
}

export interface ArticleSetting {
  readonly enabled: boolean;
}

export interface ModerationSettings {
  readonly comment: Readonly<Record<CommentCheck, CommentSetting>>;
  readonly article: Readonly<Record<string, ArticleSetting>>;
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

/**
 * Only an exact member of TENANT_KINDS is a tenant kind. Anything else, including
 * a wrong-case or empty string, a missing value or a non-string, is a demo.
 */
export function parseTenantKind(value: unknown): TenantKind {
  return typeof value === 'string' && (TENANT_KINDS as readonly string[]).includes(value)
    ? (value as TenantKind)
    : 'DEMO';
}

/** The defaults are placeholders, not a decision: the page never presents them as saved. */
export function defaultSettings(articleChecks: readonly string[]): ModerationSettings {
  const comment = Object.fromEntries(
    COMMENT_CHECKS.map((id) => [id, { enabled: true, sensitivity: 'medium' as Sensitivity }])
  ) as Record<CommentCheck, CommentSetting>;
  const article = Object.fromEntries(articleChecks.map((id) => [id, { enabled: true }]));
  return { comment, article };
}

const checkedAttr = (on: boolean): string => (on ? ' checked' : '');

/** A disabled toggle. It is never built for a check in the absolute or floor tier. */
export function renderToggle(group: 'comment' | 'article', id: string, on: boolean): string {
  assertConfigurable(id);
  const name = escapeHtml(`${group}.${id}.enabled`);
  return `<label><input type="checkbox" name="${name}" value="1" disabled${checkedAttr(on)}> ${escapeHtml(
    `${group.toUpperCase()}_LABEL_${id.toUpperCase()}`
  )}</label>`;
}

/** A mandatory floor check: read-only, with no input element and no link. */
export function renderFloorRow(id: string): string {
  if (!(FLOOR_CHECKS as readonly string[]).includes(id)) throw new NotConfigurableError(id);
  return `<li>${escapeHtml(`FLOOR_LABEL_${id.toUpperCase()}`)} APPEAL_LINK_NOT_YET_AVAILABLE</li>`;
}

/** A disabled sensitivity select. */
export function renderSensitivity(id: CommentCheck, current: Sensitivity): string {
  assertConfigurable(id);
  const name = escapeHtml(`comment.${id}.sensitivity`);
  const options = SENSITIVITIES.map(
    (level) =>
      `<option value="${level}"${level === current ? ' selected' : ''}>${escapeHtml(
        `SENSITIVITY_${level.toUpperCase()}`
      )}</option>`
  ).join('');
  return `<select name="${name}" disabled>${options}</select>`;
}

export interface ModerationView {
  readonly kind: unknown;
  readonly settings: ModerationSettings;
  readonly articleChecks: readonly string[];
}

/**
 * The moderation page body. Only an exact REAL tenant gets the controls; any
 * other kind gets the demo notice. The controls are disabled and there is no
 * form, submit control or link: nothing here can be saved or followed yet.
 */
export function renderModeration(view: ModerationView): string {
  if (parseTenantKind(view.kind) !== 'REAL') {
    return '<h1>MODERATION_TITLE</h1><p>DEMO_NO_MODERATION_SETTINGS</p>';
  }
  const floor = FLOOR_CHECKS.map(renderFloorRow).join('');
  const comments = COMMENT_CHECKS.map((id) => {
    const setting = view.settings.comment[id];
    return `<li>${renderToggle('comment', id, setting.enabled)} ${renderSensitivity(
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
    '<p>SETTINGS_NOT_YET_SAVED: THE_CONTROLS_BELOW_SHOW_PLACEHOLDER_DEFAULTS_NOT_A_DECISION_AND_CANNOT_BE_CHANGED</p>' +
    `<h2>FLOOR_HEADING</h2><ul>${floor}</ul>` +
    `<h2>COMMENT_HEADING</h2><ul>${comments}</ul>` +
    `<h2>ARTICLE_HEADING</h2><ul>${articles}</ul>`
  );
}

/**
 * The page's body for one signed-in tenant. The kind comes from the seam, and an
 * absent or failed seam is a demo: the settings are the placeholders either way.
 */
export async function moderationBody<S>(
  scope: S,
  kindOf: ((scope: S) => Promise<unknown>) | undefined
): Promise<string> {
  const kind = parseTenantKind(kindOf === undefined ? undefined : await kindOf(scope));
  return renderModeration({
    kind,
    settings: defaultSettings(ARTICLE_CHECKS),
    articleChecks: ARTICLE_CHECKS,
  });
}
