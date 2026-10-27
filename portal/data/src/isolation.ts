import { is } from 'drizzle-orm';
import {
  PgDialect,
  PgTable,
  getTableConfig,
  type PgPolicy,
  type PgPolicyToOption,
} from 'drizzle-orm/pg-core';
import { portalTenant } from './schema.js';

export class UnisolatedTableError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(`tenant table without row-level isolation: ${tables.join(', ')}`);
    this.name = 'UnisolatedTableError';
  }
}

const POLICY_NAME = 'tenant_isolation';

const dialect = new PgDialect();

/** A rendered predicate with quoting and whitespace removed, which are not what is compared. */
function normalised(text: string): string {
  return text.replace(/["\s]/g, '');
}

/**
 * Whether `predicate` renders, with no parameters, to the expected text. A
 * missing predicate, `true`, another column or function, and `... OR true` all
 * differ from it.
 */
function isExpectedPredicate(predicate: PgPolicy['using'], expected: string): boolean {
  if (predicate === undefined) return false;
  const query = dialect.sqlToQuery(predicate);
  return query.params.length === 0 && normalised(query.sql) === expected;
}

/** The role names a policy applies to; an omitted `to` is PUBLIC. */
function appliesTo(policy: PgPolicy): string[] {
  const names = (option: PgPolicyToOption): string[] => {
    if (Array.isArray(option)) return option.flatMap(names);
    return [typeof option === 'string' ? option : option.name];
  };
  return policy.to === undefined ? ['public'] : names(policy.to);
}

/**
 * Whether a `tenant_isolation` policy is the one every tenant table must carry:
 * permissive, for all commands, explicitly for the tenant role, with its
 * `USING` and its `WITH CHECK` both comparing the table's `tenant_id` to
 * `public.bound_tenant()`. Other policies on the table are not judged here:
 * the provisioning command's live check pins the deployed set exactly.
 */
function isSoundPolicy(policy: PgPolicy, expected: string): boolean {
  return (
    (policy.as ?? 'permissive') === 'permissive' &&
    (policy.for ?? 'all') === 'all' &&
    appliesTo(policy).includes(portalTenant.name) &&
    isExpectedPredicate(policy.using, expected) &&
    isExpectedPredicate(policy.withCheck, expected)
  );
}

/**
 * Refuses a schema in which a table carrying a `tenant_id` column has no row
 * security, no `tenant_isolation` policy, or one whose predicate is not
 * `<table>.tenant_id = public.bound_tenant()` for both reads and writes: a
 * tenant table cannot be added with the filter forgotten or neutered. Takes
 * the exports of a schema module.
 */
export function assertTenantTablesIsolated(schemaExports: Record<string, unknown>): void {
  const open: string[] = [];
  for (const value of Object.values(schemaExports)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    if (!config.columns.some((column) => column.name === 'tenant_id')) continue;
    const expected = `${config.schema === undefined ? '' : `${config.schema}.`}${config.name}.tenant_id=public.bound_tenant()`;
    const policies = config.policies.filter((policy) => policy.name === POLICY_NAME);
    const isolated =
      config.enableRLS &&
      policies.length > 0 &&
      policies.every((policy) => isSoundPolicy(policy, expected));
    if (!isolated) open.push(config.name);
  }
  if (open.length > 0) throw new UnisolatedTableError(open);
}
