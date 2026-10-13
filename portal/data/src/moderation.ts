import type { moderationSetting } from './schema.js';
import type { CommentCheck, Sensitivity } from './schema.js';

export { COMMENT_CHECKS, SENSITIVITIES } from './schema.js';
export type { CommentCheck, Sensitivity } from './schema.js';

/** What a tenant has saved for one comment check. */
export interface CommentSettingView {
  enabled: boolean;
  sensitivity: Sensitivity;
}

/** One requested change. The check and sensitivity are untrusted text until validated. */
export interface CommentSettingChange {
  check: string;
  enabled: boolean;
  sensitivity: string;
}

/** The saved settings by check; a check the tenant has not saved is absent. */
export type SavedModerationSettings = Partial<Record<CommentCheck, CommentSettingView>>;

export function deriveSavedSettings(
  rows: readonly (typeof moderationSetting.$inferSelect)[]
): SavedModerationSettings {
  const saved: SavedModerationSettings = {};
  for (const row of rows) {
    saved[row.checkId as CommentCheck] = {
      enabled: row.enabled,
      sensitivity: row.sensitivity as Sensitivity,
    };
  }
  return saved;
}

/** A check that is not one of the configurable comment checks, whatever tier it is in. */
export class UnknownCheckError extends Error {
  constructor(readonly check: string) {
    super(`check ${check} is not a configurable comment check`);
    this.name = 'UnknownCheckError';
  }
}

/** A sensitivity outside the closed list, or a request that names a check twice or none. */
export class InvalidSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSettingError';
  }
}
