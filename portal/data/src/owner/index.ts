import { asc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { connect, enterRole, type PortalDb, type Tx } from '../db.js';
import { deriveHealthView } from '../healthView.js';
import { deriveReading, type HealthView } from '../reading.js';
import { healthReading, tenantRegister } from '../schema.js';

export { MalformedScrapeError, type HealthView } from '../reading.js';
import { parseTenantId } from '../tenantId.js';
import type { TenantRegistration } from '../tenant/session.js';

/**
 * The owner console's cross-tenant reads and the register's writes. A
 * separate entry point on purpose: the tenant-facing code never imports it,
 * and the pool it takes is connected as a login that is a member of
 * `portal_owner` alone.
 */
export class OwnerDb {
  private readonly db: PortalDb;

  constructor(pool: Pool) {
    this.db = connect(pool);
  }

  /** One unit of work as the `portal_owner` role. */
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await enterRole(tx, 'portal_owner');
      return work(tx);
    });
  }

  async registerTenant(registration: TenantRegistration): Promise<void> {
    const tenantId = parseTenantId(registration.tenantId);
    await this.run(async (tx) => {
      await tx.insert(tenantRegister).values({ tenantId, zitadelOrgId: registration.zitadelOrgId });
    });
  }

  async listTenants(): Promise<TenantRegistration[]> {
    return this.run(async (tx) => {
      const rows = await tx
        .select()
        .from(tenantRegister)
        .orderBy(asc(tenantRegister.createdAt), asc(tenantRegister.tenantId));
      return rows.map((row) => ({ tenantId: row.tenantId, zitadelOrgId: row.zitadelOrgId }));
    });
  }

  /**
   * Records the latest reading for one tenant from its colours' scrapes. The
   * mismatch date is the first reading of a continuing mismatch: a matching
   * reading clears it, a mismatching one keeps an earlier date, and a reading
   * that cannot tell leaves it as it was.
   */
  async recordReading(
    tenantId: string,
    scrapes: readonly string[],
    observedAt: Date
  ): Promise<void> {
    const id = parseTenantId(tenantId);
    const reading = deriveReading(scrapes);
    await this.run(async (tx) => {
      const [existing] = await tx
        .select({ mismatchSince: healthReading.mismatchSince })
        .from(healthReading)
        .where(eq(healthReading.tenantId, id))
        .for('update');
      let mismatchSince = existing?.mismatchSince ?? null;
      if (reading.versionMatch === true) mismatchSince = null;
      else if (reading.versionMatch === false) mismatchSince ??= observedAt;
      const values = {
        health: reading.health,
        reportedVersion: reading.reportedVersion,
        versionMatch: reading.versionMatch,
        mismatchSince,
        observedAt,
      };
      await tx
        .insert(healthReading)
        .values({ tenantId: id, ...values })
        .onConflictDoUpdate({ target: healthReading.tenantId, set: values });
    });
  }

  /**
   * Every registered tenant with its latest reading, null where none has been
   * recorded: the console's cross-tenant read.
   */
  async listHealth(): Promise<Array<{ tenantId: string; health: HealthView | null }>> {
    return this.run(async (tx) => {
      const rows = await tx
        .select({ register: tenantRegister, reading: healthReading })
        .from(tenantRegister)
        .leftJoin(healthReading, eq(healthReading.tenantId, tenantRegister.tenantId))
        .orderBy(asc(tenantRegister.createdAt), asc(tenantRegister.tenantId));
      return rows.map((row) => ({
        tenantId: row.register.tenantId,
        health: row.reading ? deriveHealthView(row.reading) : null,
      }));
    });
  }
}
