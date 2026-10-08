import { asc, desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { connect, enterRole, type PortalDb, type Tx } from '../db.js';
import { deriveHealthView } from '../healthView.js';
import { deriveReading, type HealthView } from '../reading.js';
import {
  InvalidPublicationError,
  SUBPROCESSOR_NOTICE_DAYS,
  deriveDocumentView,
  type DocumentKind,
  type DocumentView,
  type SubprocessorEntry,
} from '../documents.js';
import { documentVersion, healthReading, tenantRegister } from '../schema.js';

export { MalformedScrapeError, type HealthView } from '../reading.js';
export { InvalidPublicationError, SUBPROCESSOR_NOTICE_DAYS } from '../documents.js';
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

  /**
   * Publishes the next version of a document. The version number is the
   * previous one plus one. A sub-processor list version must name at least one
   * entry and carries a notice period of at least `SUBPROCESSOR_NOTICE_DAYS`
   * (the default); it takes effect no earlier than the moment
   * of publication plus that notice. The moment of publication is the
   * database's own clock, set by the column default and never taken from the
   * caller, and the table refuses an earlier effective date, so a new entry is
   * not in force inside its notice however the call is made.
   */
  async publishDocument(input: {
    kind: DocumentKind;
    title: string;
    body: string;
    entries?: SubprocessorEntry[];
    effectiveAt: Date;
    noticeDays?: number;
  }): Promise<DocumentView> {
    const entries = input.entries ?? [];
    const isList = input.kind === 'subprocessors';
    const noticeDays = input.noticeDays ?? (isList ? SUBPROCESSOR_NOTICE_DAYS : 0);
    if (isList && entries.length === 0) {
      throw new InvalidPublicationError('a sub-processor list version names its entries');
    }
    if (!isList && entries.length > 0) {
      throw new InvalidPublicationError('only the sub-processor list carries entries');
    }
    if (isList && noticeDays < SUBPROCESSOR_NOTICE_DAYS) {
      throw new InvalidPublicationError(
        `a sub-processor list version carries a notice of at least ${SUBPROCESSOR_NOTICE_DAYS} days`
      );
    }
    return this.run(async (tx) => {
      const [latest] = await tx
        .select({ version: documentVersion.version })
        .from(documentVersion)
        .where(eq(documentVersion.kind, input.kind))
        .orderBy(desc(documentVersion.version))
        .limit(1);
      const inserted = await tx
        .insert(documentVersion)
        .values({
          kind: input.kind,
          version: (latest?.version ?? 0) + 1,
          title: input.title,
          body: input.body,
          entries,
          effectiveAt: input.effectiveAt,
          noticeDays,
        })
        .returning()
        .catch((error: unknown) => {
          if (isNoticeRefusal(error)) {
            throw new InvalidPublicationError(
              'a new sub-processor entry is not effective inside its notice period'
            );
          }
          throw error;
        });
      return deriveDocumentView(inserted[0]!);
    });
  }
}

/** Whether the database refused a row for taking effect inside its notice. */
function isNoticeRefusal(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | null)?.cause;
  return cause?.code === '23514' && cause.constraint === 'document_version_notice_elapsed';
}
