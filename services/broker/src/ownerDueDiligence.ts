/**
 * The address of the platform owner, who is a reader of every demo and
 * receives each demo's viewing passphrase for due diligence before approving
 * a promotion. It comes from one configuration value and nowhere else: it is
 * in no source, no log line and no descriptor. See ownerDueDiligence.md.
 */
import { validateEmailAddress, type EmailAddress } from '@branchleft/ghost-platform-render-core';

export const OWNER_DUE_DILIGENCE_ENV = 'OWNER_DUE_DILIGENCE_EMAIL';

/** The setting is absent or unusable, so no demo may be created. */
export class OwnerDueDiligenceUnsetError extends Error {
  constructor(why: string) {
    super(
      `${OWNER_DUE_DILIGENCE_ENV} ${why}: a demo is never created without the owner as a ` +
        'reader, so provisioning is refused rather than skipping the owner'
    );
    this.name = 'OwnerDueDiligenceUnsetError';
  }
}

/**
 * Checks a value that should already be the owner's address. Never echoes
 * the value: a refusal reaches logs.
 *
 * @throws OwnerDueDiligenceUnsetError when it is missing, blank or not an address
 */
export function assertOwnerDueDiligenceEmail(value: unknown): EmailAddress {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OwnerDueDiligenceUnsetError('is not set');
  }
  const trimmed = value.trim();
  // The address is later placed inside a quoted filter; a quote or a
  // backslash would end that quoting early.
  if (/['"\\]/.test(trimmed)) {
    throw new OwnerDueDiligenceUnsetError('is not a valid email address (value withheld)');
  }
  try {
    return validateEmailAddress(trimmed, OWNER_DUE_DILIGENCE_ENV);
  } catch {
    throw new OwnerDueDiligenceUnsetError('is not a valid email address (value withheld)');
  }
}

/**
 * Reads the setting from an environment. Unset is a refusal, never a quiet
 * default.
 *
 * @throws OwnerDueDiligenceUnsetError
 */
export function ownerDueDiligenceEmailFromEnv(
  env: Readonly<Record<string, string | undefined>>
): EmailAddress {
  return assertOwnerDueDiligenceEmail(env[OWNER_DUE_DILIGENCE_ENV]);
}
