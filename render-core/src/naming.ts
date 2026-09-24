/**
 * Every name this package derives from a tenant slug, in one place.
 *
 * Ported from `infra/tenant/naming.ts` (LLD-1 §04: "Otherwise unchanged —
 * every path still derives from the slug"), minus the reserved-name and
 * slug-shape checks: `validate()` already enforces the slug grammar
 * (`brand.ts#validateSlug`) before a `Slug` reaches this module, and host
 * availability (the reserved-stack-name list) is a fact about a specific
 * host, not about the descriptor — it stays the caller's concern rather
 * than becoming part of a pure, host-independent render.
 */

import type { Slug } from './brand.js';

/** Mirrors `db/provision/naming.py`'s `TENANT_DB_PREFIX`. Kept identical so a
 * slug that is valid here is valid there too. */
export const TENANT_DB_PREFIX = 'ghost_';

/** MySQL identifiers cannot carry the hyphens a slug may. */
export function sqlIdentifier(slug: Slug): string {
  return slug.replaceAll('-', '_');
}

/** The tenant's logical database and its dedicated DB user share this name. */
export function databaseAndUserName(slug: Slug): string {
  return `${TENANT_DB_PREFIX}${sqlIdentifier(slug)}`;
}

/**
 * The Compose project name, which is also the systemd instance name, the
 * directory under `/opt/branchleft` and the stem of both files under
 * `/etc/branchleft`. One value, because `branchleft-compose@.service` and
 * `branchleft-deploy` already treat them as one.
 */
export function stackName(slug: Slug): string {
  return slug;
}

export function stackDirectory(slug: Slug): string {
  return `/opt/branchleft/${stackName(slug)}`;
}

export function composeUnitName(slug: Slug): string {
  return `branchleft-compose@${stackName(slug)}.service`;
}

/** Root-owned `0600`, written by an operator and by no automated path. */
export function secretsEnvPath(slug: Slug): string {
  return `/etc/branchleft/${stackName(slug)}.env`;
}

/** Written by `branchleft-deploy` alone; never the same file as the above. */
export function imageEnvPath(slug: Slug): string {
  return `/etc/branchleft/${stackName(slug)}.image.env`;
}

/**
 * Volume names are given explicitly rather than left to Compose's
 * `<project>_<volume>` prefixing — see `infra/tenant/naming.ts`'s own
 * comment, unchanged here: the host-side provisioning step creates these
 * before any Compose project exists to derive a prefix from.
 */
export function contentVolumeName(slug: Slug): string {
  return `ghost-${slug}-content`;
}

export function adaptersVolumeName(slug: Slug): string {
  return `ghost-${slug}-adapters`;
}
