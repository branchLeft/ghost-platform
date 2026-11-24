/**
 * The tenant's ActivityPub federation switch: one fact in the register, off by
 * default. Only a real tenant may change it; a demo slot is refused here and
 * again by the database's own check on the register.
 */

/** The one form field the page sends, when the switch is on. */
export const FEDERATION_FIELD = 'federation.enabled';

export class FederationNotAvailableError extends Error {
  constructor() {
    super('federation is not available for this tenant');
    this.name = 'FederationNotAvailableError';
  }
}

/** A posted form that names a field the page never sends, or a bad value. */
export class InvalidFederationFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFederationFormError';
  }
}

/**
 * The posted form as the requested switch position. The page sends
 * `federation.enabled=1` when on and nothing when off. Any other field, a
 * repeated field or any other value is refused whole.
 */
export function parseFederationForm(form: URLSearchParams): boolean {
  for (const key of new Set(form.keys())) {
    if (key !== FEDERATION_FIELD) {
      throw new InvalidFederationFormError(`field ${key} is not a federation setting`);
    }
  }
  const values = form.getAll(FEDERATION_FIELD);
  if (values.length === 0) return false;
  if (values.length !== 1 || values[0] !== '1') {
    throw new InvalidFederationFormError(`field ${FEDERATION_FIELD} has a bad value`);
  }
  return true;
}
