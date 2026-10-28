import { sql, type SQL } from 'drizzle-orm';
import {
  pgPolicy,
  pgSchema,
  pgTable,
  uuid,
  type AnyPgColumn,
  type PgPolicyConfig,
} from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { UnisolatedTableError, assertTenantTablesIsolated } from '../src/isolation.js';
import { portalOwner, portalTenant } from '../src/schema.js';
import * as schema from '../src/schema.js';

// The check is static, so these tables are never migrated: they exist only to be
// judged. Each one is named for the case it stands for.
const fixture = pgSchema('portal_test');

interface Columns {
  id: AnyPgColumn;
  tenantId: AnyPgColumn;
}

type PolicyFor = (t: Columns) => PgPolicyConfig | undefined;

function isolated(t: Columns): SQL {
  return sql`${t.tenantId} = public.bound_tenant()`;
}

/** The policy the shipped tables carry; a case spreads it and breaks one part. */
function sound(t: Columns): PgPolicyConfig {
  return {
    as: 'permissive',
    for: 'all',
    to: portalTenant,
    using: isolated(t),
    withCheck: isolated(t),
  };
}

function tableWith(name: string, policy: PolicyFor, rowSecurity = true) {
  const table = fixture.table(
    name,
    { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull() },
    (t) => {
      const config = policy(t);
      return config === undefined ? [] : [pgPolicy('tenant_isolation', config)];
    }
  );
  return rowSecurity ? table.enableRLS() : table;
}

/** What the check says about `table` alone: the names it refuses, or none. */
function refused(table: Record<string, unknown>): readonly string[] {
  try {
    assertTenantTablesIsolated(table);
  } catch (error) {
    expect(error).toBeInstanceOf(UnisolatedTableError);
    return (error as UnisolatedTableError).tables;
  }
  return [];
}

const BROKEN: Record<string, PolicyFor> = {
  using_true: (t) => ({ ...sound(t), using: sql`true` }),
  check_true: (t) => ({ ...sound(t), withCheck: sql`true` }),
  both_true: (t) => ({ ...sound(t), using: sql`true`, withCheck: sql`true` }),
  other_column: (t) => ({ ...sound(t), using: sql`${t.id} = public.bound_tenant()` }),
  check_other_column: (t) => ({ ...sound(t), withCheck: sql`${t.id} = public.bound_tenant()` }),
  other_function: (t) => ({ ...sound(t), using: sql`${t.tenantId} = public.bound_organisation()` }),
  or_true: (t) => ({ ...sound(t), using: sql`${t.tenantId} = public.bound_tenant() OR true` }),
  check_or_true: (t) => ({
    ...sound(t),
    withCheck: sql`${t.tenantId} = public.bound_tenant() OR true`,
  }),
  trailing_comment: (t) => ({
    ...sound(t),
    using: sql`${t.tenantId} = public.bound_tenant() -- OR true`,
  }),
  a_parameter: (t) => ({ ...sound(t), using: sql`${t.tenantId} = ${'not-a-function'}` }),
  using_missing: (t) => ({ ...sound(t), using: undefined }),
  check_missing: (t) => ({ ...sound(t), withCheck: undefined }),
  for_select: (t) => ({ ...sound(t), for: 'select' }),
  for_insert: (t) => ({ ...sound(t), for: 'insert' }),
  to_public: (t) => ({ ...sound(t), to: undefined }),
  to_owner_only: (t) => ({ ...sound(t), to: portalOwner }),
  to_other_name: (t) => ({ ...sound(t), to: ['some_other_role'] }),
  restrictive: (t) => ({ ...sound(t), as: 'restrictive' }),
};

describe('assertTenantTablesIsolated reads the policy, not its name', () => {
  it.each(Object.entries(BROKEN))('refuses a tenant_isolation policy with %s', (name, policy) => {
    expect(refused({ [name]: tableWith(name, policy) })).toEqual([name]);
  });

  it('refuses a table whose row security is off, whatever its policy says', () => {
    expect(refused({ t: tableWith('rls_off', sound, false) })).toEqual(['rls_off']);
  });

  it('refuses a table with no tenant_isolation policy at all', () => {
    expect(refused({ t: tableWith('no_policy', () => undefined) })).toEqual(['no_policy']);
  });

  it('names every broken table and only those', () => {
    const tables = {
      good: tableWith('good', sound),
      bad_one: tableWith('bad_one', BROKEN['using_true'] as PolicyFor),
      bad_two: tableWith('bad_two', BROKEN['or_true'] as PolicyFor),
    };
    expect(refused(tables)).toEqual(['bad_one', 'bad_two']);
  });
});

describe('assertTenantTablesIsolated compares a normalised rendering', () => {
  it('accepts the policy the shipped tables carry', () => {
    expect(refused({ t: tableWith('exact', sound) })).toEqual([]);
  });

  it('accepts the same predicate with other whitespace and no quoting', () => {
    const spaced = (t: Columns): PgPolicyConfig => ({
      ...sound(t),
      using: sql.raw('portal_test.spaced.tenant_id   =\n\tpublic.bound_tenant( )'),
      withCheck: sql.raw('  "portal_test"."spaced"."tenant_id"="public"."bound_tenant"()'),
    });
    expect(refused({ t: tableWith('spaced', spaced) })).toEqual([]);
  });

  it('accepts the policy with its defaults left out and several roles named', () => {
    const defaults = (t: Columns): PgPolicyConfig => ({
      to: [portalOwner, [portalTenant]],
      using: isolated(t),
      withCheck: isolated(t),
    });
    expect(refused({ t: tableWith('defaults', defaults) })).toEqual([]);
  });

  it('accepts the tenant role named as a string', () => {
    const named = (t: Columns): PgPolicyConfig => ({ ...sound(t), to: 'portal_tenant' });
    expect(refused({ t: tableWith('named', named) })).toEqual([]);
  });

  it('expects the table name only for a table outside any schema', () => {
    const plain = pgTable('plain', { tenantId: uuid('tenant_id').notNull() }, (t) => [
      pgPolicy('tenant_isolation', sound({ id: t.tenantId, tenantId: t.tenantId })),
    ]).enableRLS();
    expect(refused({ plain })).toEqual([]);
  });

  it('judges a predicate that names another table as different', () => {
    const wrongTable = (t: Columns): PgPolicyConfig => ({
      ...sound(t),
      using: sql.raw('portal_test.someone_else.tenant_id = public.bound_tenant()'),
    });
    expect(refused({ t: tableWith('wrong_table', wrongTable) })).toEqual(['wrong_table']);
  });
});

describe('the shipped schema', () => {
  it('still passes', () => {
    expect(refused(schema)).toEqual([]);
  });
});
