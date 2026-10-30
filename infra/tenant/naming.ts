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
 * The slug charset, shared with `db/provision/naming.py`. The trailing
 * character is restricted to a letter or digit — stricter than MySQL,
 * Compose or systemd need — because this same slug becomes an S3-compatible
 * bucket name in `mediaBucketName`. See naming.md#tenant_slug_pattern.
 */
const TENANT_SLUG_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

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

// BEGIN GENERATED FROM registers/tenant-names.json -- edit the register, then run scripts/sync-tenant-name-register.py
export type RegisteredName =
  | { readonly name: string; readonly kind: 'infrastructure' }
  | { readonly name: string; readonly kind: 'tenant'; readonly repo: string };

export const TENANT_NAME_REGISTER: readonly RegisteredName[] = [
  { name: 'website', kind: 'infrastructure' },
  { name: 'edge', kind: 'infrastructure' },
  { name: 'db', kind: 'infrastructure' },
  { name: 'monitoring', kind: 'infrastructure' },
  { name: 'nextcloud1', kind: 'infrastructure' },
  { name: 'mail-spool', kind: 'infrastructure' },
  { name: 'blog', kind: 'tenant', repo: 'branchLeft/ghost-tenant-blog' },
];
// END GENERATED FROM registers/tenant-names.json

/**
 * Stack names already in use on an app host by something that is not a
 * tenant, read from the register's infrastructure entries: a slug reusing
 * one would overwrite that stack's directory, secrets file and systemd unit.
 * See naming.md#reserved_stack_names.
 */
export const RESERVED_STACK_NAMES: readonly string[] = TENANT_NAME_REGISTER.filter(
  (entry) => entry.kind === 'infrastructure'
).map((entry) => entry.name);

/** The register's tenant entries: names a tenant may take, each only from its own repo. */
export const TENANT_NAMES: readonly Extract<RegisteredName, { kind: 'tenant' }>[] =
  TENANT_NAME_REGISTER.filter(
    (entry): entry is Extract<RegisteredName, { kind: 'tenant' }> => entry.kind === 'tenant'
  );

export function validateTenantSlug(slug: string): void {
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `GhostTenant: tenant slug "${slug}" must start with a lowercase letter, end with a ` +
        `lowercase letter or digit, and contain only lowercase letters, digits and hyphens in ` +
        `between.`
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

/**
 * Refuses a registered tenant name unless the apply runs in that name's own
 * repository. The claimant is the repo Actions reports in `GITHUB_REPOSITORY`,
 * never something derived from the slug. With the variable unset (a local
 * run) a registered name is refused: tenant applies run in CI. An
 * unregistered name passes. See naming.md#validatetenantnameclaim.
 */
export function validateTenantNameClaim(
  slug: string,
  claimantRepo: string | undefined = process.env['GITHUB_REPOSITORY']
): void {
  const entry = TENANT_NAMES.find((candidate) => candidate.name === slug);
  if (entry === undefined) {
    return;
  }
  if (claimantRepo === undefined || claimantRepo.toLowerCase() !== entry.repo.toLowerCase()) {
    throw new Error(
      `GhostTenant: tenant name "${slug}" is registered to ${entry.repo}, and this apply runs in ` +
        `${claimantRepo === undefined ? 'no repository (GITHUB_REPOSITORY is unset)' : claimantRepo}. ` +
        `A name is claimed by its own repository only.`
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
 * Volume names are given explicitly in the rendered Compose file, rather
 * than left to Compose's `<project>_<volume>` prefixing, because the
 * host-side provisioning step has to create them before any Compose project
 * exists to derive a prefix from. See naming.md#contentvolumename.
 */
export function contentVolumeName(slug: string): string {
  return `ghost-${slug}-content`;
}

export function adaptersVolumeName(slug: string): string {
  return `ghost-${slug}-adapters`;
}
