import type { HealthView } from 'ghost-platform-portal-data/tenant';
import type { RecordedScreen } from './supportScreens.js';

/** The value of a context field the portal does not hold. */
export const NOT_AVAILABLE = 'NOT_AVAILABLE';

/** A reading exists and records no run of mismatching readings. */
export const NO_MISMATCH = 'NO_MISMATCH';

/** Separates the portal's context from the tenant's own words. */
export const MESSAGE_DELIMITER = '----- MESSAGE -----';

/**
 * The closed list of context fields, in the order they appear in the email.
 * Every one is always emitted as a `NAME: value` line.
 */
export const CONTEXT_FIELDS = [
  'TENANT_ID',
  'SITE_HEALTH',
  'GHOST_VERSION',
  'VERSION_CHECK',
  'MISMATCH_SINCE',
  'OBSERVED_AT',
  'SITE_HOST',
  'LAST_DEPLOY',
  'SCREEN',
] as const;

export type ContextField = (typeof CONTEXT_FIELDS)[number];

export interface ContextInput {
  readonly tenantId: string;
  readonly health: HealthView | null;
  readonly screen: RecordedScreen;
}

const CONTROL_CHARACTERS = /[\r\n\0]/g;

/** A value a reading supplied is untrusted text: no line break may survive, and blank is absent. */
function present(value: string | null | undefined): string {
  const clean = (value ?? '').replaceAll(CONTROL_CHARACTERS, ' ').trim();
  return clean === '' ? NOT_AVAILABLE : clean;
}

function versionCheck(health: HealthView | null): string {
  if (health === null || health.versionMatch === null) return NOT_AVAILABLE;
  return health.versionMatch ? 'VERSION_MATCHES' : 'VERSION_MISMATCH';
}

function mismatchSince(health: HealthView | null): string {
  if (health === null) return NOT_AVAILABLE;
  return health.mismatchSince === null ? NO_MISMATCH : health.mismatchSince.toISOString();
}

/** One entry per field: a missing entry fails to compile, so the list and the lines cannot drift. */
const VALUES: Readonly<Record<ContextField, (input: ContextInput) => string>> = {
  TENANT_ID: (input) => present(input.tenantId),
  SITE_HEALTH: (input) => present(input.health?.health),
  GHOST_VERSION: (input) => present(input.health?.reportedVersion),
  VERSION_CHECK: (input) => versionCheck(input.health),
  MISMATCH_SINCE: (input) => mismatchSince(input.health),
  OBSERVED_AT: (input) => present(input.health?.observedAt.toISOString()),
  SITE_HOST: () => NOT_AVAILABLE,
  LAST_DEPLOY: () => NOT_AVAILABLE,
  SCREEN: (input) => present(input.screen),
};

/** The labelled context lines, one per field of `CONTEXT_FIELDS`, none omitted or empty. */
export function buildContextLines(input: ContextInput): readonly string[] {
  return CONTEXT_FIELDS.map((field) => `${field}: ${VALUES[field](input)}`);
}

/** The plain-text body: the context, then the tenant's message below the delimiter. */
export function renderTicketBody(contextLines: readonly string[], message: string): string {
  return `${contextLines.join('\n')}\n\n${MESSAGE_DELIMITER}\n${message}`;
}
