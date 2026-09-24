/**
 * Every name this package derives from a tenant slug, in one place.
 *
 * Ported from `infra/tenant/naming.ts` (LLD-1 §04: "Otherwise unchanged —
 * every path still derives from the slug"), including the reserved-name
 * list and the MySQL slug-length limit: LLD-1 §07 finding L1 is explicit
 * that a wrong slug here is "not harmless the moment the broker does [pick
 * slugs]", so both stay part of this package's own validation rather than
 * left to a caller. `validate()` calls `validateSlugAvailability` alongside
 * the grammar check `brand.ts#validateSlug` already does.
 */

import type { Slug } from './brand.js';
import { FieldValidationError } from './brand.js';
import type { DatabaseSpec } from './descriptor.js';

/** Mirrors `db/provision/naming.py`'s `TENANT_DB_PREFIX`. Kept identical so a
 * slug that is valid here is valid there too. */
export const TENANT_DB_PREFIX = 'ghost_';

/**
 * MySQL's account-name limit is 32 characters and the tenant's database and
 * dedicated user share one name of `ghost_<sql-id>`, so the slug has this
 * many characters left — mirrors `infra/tenant/naming.ts#MAX_TENANT_SLUG_LENGTH`
 * exactly (32 minus `TENANT_DB_PREFIX`'s own length).
 */
export const MAX_TENANT_SLUG_LENGTH = 32 - TENANT_DB_PREFIX.length;

/**
 * Stack names already in use on an app host by something that is not a
 * tenant — mirrors `infra/tenant/naming.ts#RESERVED_STACK_NAMES`, extended
 * with the two live stacks (`blog`, `nextcloud1`) an earlier four-name list
 * omitted. A tenant's Compose project name *is* its directory under
 * `/opt/branchleft`, its `/etc/branchleft/<name>.env` secrets file and its
 * `branchleft-compose@<name>` unit, so a slug matching one of these would
 * overwrite that stack's directory, secrets file and systemd unit.
 */
export const RESERVED_STACK_NAMES: readonly string[] = [
  'website',
  'edge',
  'db',
  'monitoring',
  'blog',
  'nextcloud1',
];

/**
 * The availability half of slug validation: not whether the slug is
 * well-formed (`brand.ts#validateSlug` already checked that before a
 * `Slug` reached this module) but whether it names something else already
 * on the host, or is too long for the MySQL account it becomes.
 */
export function validateSlugAvailability(slug: Slug): void {
  if (slug.length > MAX_TENANT_SLUG_LENGTH) {
    throw new FieldValidationError(
      'slug',
      `slug "${slug}" is ${slug.length} characters; must be at most ${MAX_TENANT_SLUG_LENGTH} so ` +
        `"${TENANT_DB_PREFIX}" plus the slug fits MySQL's 32-character account-name limit.`
    );
  }
  if (RESERVED_STACK_NAMES.includes(slug)) {
    throw new FieldValidationError(
      'slug',
      `slug "${slug}" is reserved — an app host already runs a Compose stack of that name, and a ` +
        `tenant using it would overwrite that stack's directory, secrets file and systemd unit. ` +
        `Reserved: ${RESERVED_STACK_NAMES.join(', ')}.`
    );
  }
}

/** MySQL identifiers cannot carry the hyphens a slug may. */
export function sqlIdentifier(slug: Slug): string {
  return slug.replaceAll('-', '_');
}

/** The tenant's logical database and its dedicated DB user share this name. */
export function databaseAndUserName(slug: Slug): string {
  return `${TENANT_DB_PREFIX}${sqlIdentifier(slug)}`;
}

/**
 * Refuses a `mysql` `DatabaseSpec` whose `name`/`user` disagree with the
 * slug-derived identity — the same isolation control
 * `media.ts#validateMediaBucket` applies to the bucket: a validated
 * descriptor must never be able to name another tenant's database.
 */
export function validateDatabaseIdentity(
  slug: Slug,
  database: Extract<DatabaseSpec, { kind: 'mysql' }>
): void {
  const expected = databaseAndUserName(slug);
  if (database.name !== expected) {
    throw new FieldValidationError(
      'database.name',
      `database.name "${database.name}" must be "${expected}", the name this slug alone derives ` +
        `— a descriptor may never name another tenant's database.`
    );
  }
  if (database.user !== expected) {
    throw new FieldValidationError(
      'database.user',
      `database.user "${database.user}" must be "${expected}", the name this slug alone derives ` +
        `— a descriptor may never name another tenant's database user.`
    );
  }
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
