import { eq, sql, type SQL } from 'drizzle-orm';
import { supportAccessReading, supportAccessRequest } from '../src/schema.js';
import type { Fixture } from './helpers.js';

/**
 * Administrator-side statements the support-access tests run against the
 * fixture database, written as `sql` templates so none is a bare SQL string.
 * Each loosening removes one control for the length of a probe.
 */
export interface Loosening {
  readonly apply: readonly SQL[];
  readonly restore: readonly SQL[];
}

export const READING_POLICY_OPEN: Loosening = {
  apply: [sql`ALTER POLICY tenant_isolation ON portal.support_access_reading USING (true)`],
  restore: [
    sql`ALTER POLICY tenant_isolation ON portal.support_access_reading USING (tenant_id = public.bound_tenant())`,
  ],
};

export const REQUEST_CHECK_OPEN: Loosening = {
  apply: [sql`ALTER POLICY tenant_isolation ON portal.support_access_request WITH CHECK (true)`],
  restore: [
    sql`ALTER POLICY tenant_isolation ON portal.support_access_request WITH CHECK (tenant_id = public.bound_tenant())`,
  ],
};

export const READING_TENANT_WRITE: Loosening = {
  apply: [sql`GRANT INSERT, UPDATE ON portal.support_access_reading TO portal_tenant`],
  restore: [sql`REVOKE INSERT, UPDATE ON portal.support_access_reading FROM portal_tenant`],
};

export const REQUEST_TENANT_REWRITE: Loosening = {
  apply: [sql`GRANT UPDATE, DELETE ON portal.support_access_request TO portal_tenant`],
  restore: [sql`REVOKE UPDATE, DELETE ON portal.support_access_request FROM portal_tenant`],
};

export const REQUEST_TENANT_STATUS_WRITE: Loosening = {
  apply: [sql`GRANT UPDATE (status) ON portal.support_access_request TO portal_tenant`],
  restore: [sql`REVOKE UPDATE (status) ON portal.support_access_request FROM portal_tenant`],
};

export const REQUEST_INSERT_ANY_STATUS: Loosening = {
  apply: [sql`ALTER POLICY tenant_insert_open ON portal.support_access_request WITH CHECK (true)`],
  restore: [
    sql`ALTER POLICY tenant_insert_open ON portal.support_access_request WITH CHECK (status = 'open')`,
  ],
};

export const REQUEST_OPEN_NOT_UNIQUE: Loosening = {
  apply: [sql`DROP INDEX portal.support_access_request_one_open`],
  restore: [
    sql`CREATE UNIQUE INDEX support_access_request_one_open ON portal.support_access_request (tenant_id) WHERE status = 'open'`,
  ],
};

/** Runs `probe` with one control removed, and puts it back whatever the probe does. */
export async function whileLoosened(
  fixture: Fixture,
  loosening: Loosening,
  probe: () => Promise<void>
): Promise<void> {
  for (const statement of loosening.apply) await fixture.adminDb.execute(statement);
  try {
    await probe();
  } finally {
    for (const statement of loosening.restore) await fixture.adminDb.execute(statement);
  }
}

/** The columns of a portal table, by name, with their types. */
export async function columnsOf(
  fixture: Fixture,
  table: string
): Promise<Array<{ column_name: string; data_type: string }>> {
  const result = await fixture.adminDb.execute(
    sql`SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'portal' AND table_name = ${table} ORDER BY column_name`
  );
  return result.rows as Array<{ column_name: string; data_type: string }>;
}

/** The privileges a role holds on a portal table, sorted. */
export async function privilegesOf(
  fixture: Fixture,
  role: string,
  table: string
): Promise<string[]> {
  const result = await fixture.adminDb.execute(
    sql`SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = ${role} AND table_schema = 'portal' AND table_name = ${table}
         ORDER BY privilege_type`
  );
  return (result.rows as Array<{ privilege_type: string }>).map((row) => row.privilege_type);
}

export async function deleteReading(fixture: Fixture, tenantId: string): Promise<void> {
  await fixture.adminDb.execute(
    sql`DELETE FROM portal.support_access_reading WHERE tenant_id = ${tenantId}`
  );
}

/** Gives a fixture tenant the name a host's series carry as its label. */
export async function nameTenant(fixture: Fixture, tenantId: string, name: string): Promise<void> {
  await fixture.adminDb.execute(
    sql`UPDATE portal.tenant_register SET tenant_name = ${name} WHERE tenant_id = ${tenantId}`
  );
}

/** What is stored for one tenant's reading, or null. */
export async function readingRow(
  fixture: Fixture,
  tenantId: string
): Promise<{ state: string; observedAt: Date } | null> {
  const [row] = await fixture.adminDb
    .select({ state: supportAccessReading.state, observedAt: supportAccessReading.observedAt })
    .from(supportAccessReading)
    .where(eq(supportAccessReading.tenantId, tenantId));
  return row ?? null;
}

/** Every stored request, each as the database prints the whole row. */
export async function requestRowText(fixture: Fixture): Promise<string[]> {
  const result = await fixture.adminDb.execute(
    sql`SELECT r::text AS row FROM portal.support_access_request r`
  );
  return (result.rows as Array<{ row: string }>).map((row) => row.row);
}

/** Leaves one tenant with a single fresh open request, whatever history it had. */
export async function resetRequest(fixture: Fixture, tenantId: string): Promise<void> {
  await fixture.adminDb
    .delete(supportAccessRequest)
    .where(eq(supportAccessRequest.tenantId, tenantId));
  await fixture.adminDb.insert(supportAccessRequest).values({ tenantId });
}
