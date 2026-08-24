/**
 * Every name this component derives from a tenant slug, in one place.
 *
 * Pure string functions with no Pulumi types, so the whole set is testable
 * without an engine. That matters more here than it did on the GCP shape:
 * these names are not resource identifiers a provider would reject if wrong,
 * they are filesystem paths, Docker volume names and systemd instance names
 * on a host shared by every tenant. A collision is silent.
 */

/**
 * The slug charset, shared with `db/provision/naming.py`. Kept identical
 * deliberately: the same string becomes a MySQL account name there and a
 * systemd instance name here, and a slug that is valid in one place and not
 * the other produces a tenant that half-exists.
 */
const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Mirrors `db/provision/naming.py`'s `TENANT_DB_PREFIX`. */
export const TENANT_DB_PREFIX = 'ghost_';

/**
 * MySQL's account-name limit is 32 characters and the tenant's database and
 * dedicated user share one name of `ghost_<sql-id>`, so the slug has 26 to
 * work with. Every other limit this slug meets is looser — systemd instance
 * names and Docker volume names are far longer, and
 * `branchleft_deploy.py`'s own stack-name pattern allows 32 — so this is the
 * binding one and the only one worth encoding.
 */
export const MAX_TENANT_SLUG_LENGTH = 32 - TENANT_DB_PREFIX.length;

/**
 * Stack names already in use on an app host by something that is not a
 * tenant.
 *
 * A tenant's Compose project name *is* its directory under `/opt/branchleft`,
 * its `/etc/branchleft/<name>.env` secrets file and its
 * `branchleft-compose@<name>` unit. Provisioning a tenant slugged `website`
 * would therefore land on top of the marketing site's stack — overwriting its
 * secrets file and its Compose project — and nothing in Docker, systemd or
 * Pulumi would object. The refusal has to be here because this component is
 * the only thing that sees the slug before anything is written.
 */
export const RESERVED_STACK_NAMES: readonly string[] = ['website', 'edge', 'db', 'monitoring'];

export function validateTenantSlug(slug: string): void {
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `GhostTenant: tenant slug "${slug}" must start with a lowercase letter and contain only ` +
        `lowercase letters, digits and hyphens.`
    );
  }
  if (slug.length > MAX_TENANT_SLUG_LENGTH) {
    throw new Error(
      `GhostTenant: tenant slug "${slug}" is ${slug.length} characters; must be at most ` +
        `${MAX_TENANT_SLUG_LENGTH} so "${TENANT_DB_PREFIX}" plus the slug fits MySQL's ` +
        `32-character account-name limit.`
    );
  }
  if (RESERVED_STACK_NAMES.includes(slug)) {
    throw new Error(
      `GhostTenant: tenant slug "${slug}" is reserved — an app host already runs a Compose ` +
        `stack of that name, and a tenant using it would overwrite that stack's directory, ` +
        `secrets file and systemd unit. Reserved: ${RESERVED_STACK_NAMES.join(', ')}.`
    );
  }
}

/** MySQL identifiers cannot carry the hyphens a slug may. */
export function sqlIdentifier(slug: string): string {
  return slug.replaceAll('-', '_');
}

/** The tenant's logical database and its dedicated DB user share this name. */
export function databaseAndUserName(slug: string): string {
  return `${TENANT_DB_PREFIX}${sqlIdentifier(slug)}`;
}

/**
 * The Compose project name, which is also the systemd instance name, the
 * directory under `/opt/branchleft` and the stem of both files under
 * `/etc/branchleft`. One value, because `branchleft-compose@.service` and
 * `branchleft-deploy` already treat them as one.
 */
export function stackName(slug: string): string {
  return slug;
}

export function stackDirectory(slug: string): string {
  return `/opt/branchleft/${stackName(slug)}`;
}

export function composeUnitName(slug: string): string {
  return `branchleft-compose@${stackName(slug)}.service`;
}

/** Root-owned `0600`, written by an operator and by no automated path. */
export function secretsEnvPath(slug: string): string {
  return `/etc/branchleft/${stackName(slug)}.env`;
}

/** Written by `branchleft-deploy` alone; never the same file as the above. */
export function imageEnvPath(slug: string): string {
  return `/etc/branchleft/${stackName(slug)}.image.env`;
}

/**
 * Volume names are given explicitly in the rendered Compose file rather than
 * left to Compose's `<project>_<volume>` prefixing.
 *
 * The host-side provisioning step has to create these volumes, own them to
 * the tenant UID and refuse a UID another tenant already holds, and it runs
 * before any Compose project exists to derive a prefix from. A name Compose
 * would have synthesised is a name that step would have to reconstruct from
 * knowledge of Compose's prefixing rule — so it is stated once, here, and
 * both sides read it.
 */
export function contentVolumeName(slug: string): string {
  return `ghost-${slug}-content`;
}

export function adaptersVolumeName(slug: string): string {
  return `ghost-${slug}-adapters`;
}
