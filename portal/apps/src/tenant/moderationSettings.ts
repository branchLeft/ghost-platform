import {
  COMMENT_CHECKS,
  InvalidTenantKindError,
  SENSITIVITIES,
  TENANT_KINDS,
  parseTenantKind,
  type CommentCheck,
  type CommentSettingChange,
  type SavedModerationSettings,
  type Sensitivity,
  type TenantKind,
} from 'ghost-platform-portal-data/tenant';
import { escapeHtml } from '../shell/html.js';

/**
 * The tenant moderation settings page, in three tiers. The absolute layer is
 * never shown; the mandatory floor is shown read-only; the comment layer is
 * configurable and saved; the article layer is configurable in the design and
 * not yet saved, so its controls stay disabled. A demo slot sees none of the
 * configurable layers and cannot save any.
 */

/** Media hash matching: never a setting, never appealable, never shown. */
export const ABSOLUTE_CHECKS = ['media_hash'] as const;

/** Mandatory: the tenant cannot switch these off; each held item is appealable. */
export const FLOOR_CHECKS = ['threats', 'incitement', 'targeting_package', 'csam_text'] as const;

/**
 * The comment checks and sensitivities are defined once, with the table that
 * stores them, so the page and the storage cannot drift apart.
 */
export { COMMENT_CHECKS, SENSITIVITIES };
export type { CommentCheck, Sensitivity };

/** The article check set is an owner decision that has not been made: empty. */
export const ARTICLE_CHECKS: readonly string[] = [];

/** The tenant kinds are defined once, with the register that stores them. */
export { TENANT_KINDS };
export type { TenantKind };

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

/** A posted field that is not one of the page's own comment-check fields. */
export class UnrecognisedFieldError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`field ${field} is not a moderation setting`);
    this.name = 'UnrecognisedFieldError';
    this.field = field;
  }
}

/** A posted form that names a known field with a value, or a set of fields, the page never sends. */
export class InvalidModerationFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModerationFormError';
  }
}

/** A save from a tenant that is not a real one: demo slots get no configurable layer. */
export class SettingsNotAvailableError extends Error {
  constructor() {
    super('moderation settings are not available for this tenant');
    this.name = 'SettingsNotAvailableError';
  }
}

const FIELD = /^comment\.([^.]+)\.(enabled|sensitivity)$/;

/**
 * Turns the posted form into the five comment checks' settings, or refuses it
 * whole. The page sends exactly one `sensitivity` per comment check and an
 * `enabled` of `1` for each that is on. Anything else is refused: a key that
 * names an absolute or floor check anywhere in it with `NotConfigurableError`
 * (whatever its value, and before anything else is looked at), any other key
 * that is not one of those fields, a repeated field, a sensitivity outside the
 * closed list, or a form missing a check. Nothing here reads a tenant from the
 * form: the tenant is the session's.
 */
export function parseModerationForm(form: URLSearchParams): CommentSettingChange[] {
  const keys = [...new Set(form.keys())];
  for (const key of keys) {
    for (const part of key.split('.')) assertConfigurable(part);
  }
  const enabled = new Set<string>();
  const sensitivity = new Map<string, string>();
  for (const key of keys) {
    const match = FIELD.exec(key);
    const id = match?.[1] ?? '';
    if (match === null || !(COMMENT_CHECKS as readonly string[]).includes(id)) {
      throw new UnrecognisedFieldError(key);
    }
    const values = form.getAll(key);
    const value = values[0] ?? '';
    if (values.length !== 1) throw new InvalidModerationFormError(`field ${key} is repeated`);
    if (match[2] === 'enabled') {
      if (value !== '1') throw new InvalidModerationFormError(`field ${key} has a bad value`);
      enabled.add(id);
    } else {
      if (!(SENSITIVITIES as readonly string[]).includes(value)) {
        throw new InvalidModerationFormError(`field ${key} has a bad value`);
      }
      sensitivity.set(id, value);
    }
  }
  return COMMENT_CHECKS.map((check) => {
    const level = sensitivity.get(check);
    if (level === undefined) {
      throw new InvalidModerationFormError(`check ${check} has no sensitivity`);
    }
    return { check, enabled: enabled.has(check), sensitivity: level };
  });
}

/**
 * The tenant's kind from the seam, parsed strictly. An absent seam, a seam that
 * throws, or a value that is not an exact member of TENANT_KINDS is an error:
 * there is no default, so a kind that was never supplied cannot pass for either
 * a real tenant or a demo slot.
 */
async function kindFrom<S>(
  scope: S,
  kindOf: ((scope: S) => Promise<unknown>) | undefined
): Promise<TenantKind> {
  if (typeof kindOf !== 'function') throw new InvalidTenantKindError();
  return parseTenantKind(await kindOf(scope));
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

/** Refuses to build an editable control for anything but a saved comment check. */
function assertEditable(group: 'comment' | 'article', id: string): void {
  assertConfigurable(id);
  if (group !== 'comment' || !(COMMENT_CHECKS as readonly string[]).includes(id)) {
    throw new NotConfigurableError(id);
  }
}

/**
 * A toggle, disabled unless `editable`. It is never built for a check in the
 * absolute or floor tier, and an editable one only for a comment check: the
 * article layer is not saved yet.
 */
export function renderToggle(
  group: 'comment' | 'article',
  id: string,
  on: boolean,
  editable = false
): string {
  assertConfigurable(id);
  if (editable) assertEditable(group, id);
  const name = escapeHtml(`${group}.${id}.enabled`);
  const disabled = editable ? '' : ' disabled';
  return `<label><input type="checkbox" name="${name}" value="1"${disabled}${checkedAttr(on)}> ${escapeHtml(
    `${group.toUpperCase()}_LABEL_${id.toUpperCase()}`
  )}</label>`;
}

/** A mandatory floor check: read-only, with no input element and no link. */
export function renderFloorRow(id: string): string {
  if (!(FLOOR_CHECKS as readonly string[]).includes(id)) throw new NotConfigurableError(id);
  return `<li>${escapeHtml(`FLOOR_LABEL_${id.toUpperCase()}`)} APPEAL_LINK_NOT_YET_AVAILABLE</li>`;
}

/** A sensitivity select for a comment check, disabled unless `editable`. */
export function renderSensitivity(
  id: CommentCheck,
  current: Sensitivity,
  editable = false
): string {
  assertConfigurable(id);
  if (editable) assertEditable('comment', id);
  const name = escapeHtml(`comment.${id}.sensitivity`);
  const options = SENSITIVITIES.map(
    (level) =>
      `<option value="${level}"${level === current ? ' selected' : ''}>${escapeHtml(
        `SENSITIVITY_${level.toUpperCase()}`
      )}</option>`
  ).join('');
  return `<select name="${name}"${editable ? '' : ' disabled'}>${options}</select>`;
}

export interface ModerationView {
  readonly kind: TenantKind;
  readonly settings: ModerationSettings;
  readonly articleChecks: readonly string[];
  /** True once the tenant has saved any comment check; false shows the placeholder-defaults notice. */
  readonly saved?: boolean;
}

/**
 * The moderation page body. Only an exact REAL tenant gets the controls; an
 * exact DEMO gets the demo notice and no form; any other kind is an error and
 * renders nothing, so a bad kind cannot fall through to the demo notice. The
 * comment controls sit in one form that posts to the save route; the floor has
 * no input and no link, and the article controls stay disabled outside the
 * form.
 */
export function renderModeration(view: ModerationView): string {
  if (parseTenantKind(view.kind) !== 'REAL') {
    return '<h1>MODERATION_TITLE</h1><p>DEMO_NO_MODERATION_SETTINGS</p>';
  }
  const floor = FLOOR_CHECKS.map(renderFloorRow).join('');
  const comments = COMMENT_CHECKS.map((id) => {
    const setting = view.settings.comment[id];
    return `<li>${renderToggle('comment', id, setting.enabled, true)} ${renderSensitivity(
      id,
      setting.sensitivity,
      true
    )}</li>`;
  }).join('');
  const articles = view.articleChecks
    .map((id) => {
      const setting = view.settings.article[id] ?? { enabled: false };
      return `<li>${renderToggle('article', id, setting.enabled)}</li>`;
    })
    .join('');
  const notice =
    view.saved === true
      ? ''
      : '<p>SETTINGS_NOT_YET_SAVED: THE_VALUES_BELOW_ARE_PLACEHOLDER_DEFAULTS_NOT_A_DECISION</p>';
  return (
    '<h1>MODERATION_TITLE</h1>' +
    notice +
    `<h2>FLOOR_HEADING</h2><ul>${floor}</ul>` +
    '<form method="post" action="/moderation/save">' +
    `<h2>COMMENT_HEADING</h2><ul>${comments}</ul>` +
    '<button type="submit">SAVE_SETTINGS</button></form>' +
    `<h2>ARTICLE_HEADING</h2><ul>${articles}</ul>`
  );
}

/** What the page and the save route need from storage; `TenantDb` satisfies it. */
export interface ModerationStore<S> {
  moderationSettings(scope: S): Promise<SavedModerationSettings>;
  saveModerationSettings(
    scope: S,
    request: { changes: readonly CommentSettingChange[]; updatedBy: string },
    now: Date
  ): Promise<void>;
}

/** Placeholder defaults with whatever the tenant has saved laid over them. */
export function withSaved(
  defaults: ModerationSettings,
  saved: SavedModerationSettings
): ModerationSettings {
  const comment = { ...defaults.comment };
  for (const id of COMMENT_CHECKS) {
    const own = saved[id];
    if (own !== undefined) comment[id] = { enabled: own.enabled, sensitivity: own.sensitivity };
  }
  return { comment, article: defaults.article };
}

/**
 * The page's body for one signed-in tenant. The kind comes from the seam and
 * is required: an absent seam, or a value that is not an exact tenant kind,
 * throws and a demo slot reads nothing from storage. A seam or a read that
 * throws is not caught here: the shell answers 500 FAILED and renders no page.
 */
export async function moderationBody<S>(
  scope: S,
  kindOf: (scope: S) => Promise<unknown>,
  load?: (scope: S) => Promise<SavedModerationSettings>
): Promise<string> {
  const kind = await kindFrom(scope, kindOf);
  const defaults = defaultSettings(ARTICLE_CHECKS);
  const saved = kind === 'REAL' && load !== undefined ? await load(scope) : {};
  return renderModeration({
    kind,
    settings: withSaved(defaults, saved),
    articleChecks: ARTICLE_CHECKS,
    saved: Object.keys(saved).length > 0,
  });
}

/**
 * The save route's work. Only an exact REAL tenant may save: a demo slot is
 * refused with `SettingsNotAvailableError`, and an absent seam or an
 * unrecognised kind throws, so nothing is written for a kind that was never
 * supplied (the route answers both with 400 REFUSED). The form is parsed whole,
 * naming any absolute or floor check with `NotConfigurableError`, and only then
 * written: a refused form saves nothing.
 */
export async function saveModeration<S>(request: {
  readonly scope: S;
  readonly kindOf: (scope: S) => Promise<unknown>;
  readonly store: ModerationStore<S>;
  readonly updatedBy: string;
  readonly form: URLSearchParams;
  readonly now: Date;
}): Promise<void> {
  const { scope, kindOf, store, updatedBy, form, now } = request;
  const kind = await kindFrom(scope, kindOf);
  if (kind !== 'REAL') throw new SettingsNotAvailableError();
  const changes = parseModerationForm(form);
  await store.saveModerationSettings(scope, { changes, updatedBy }, now);
}
