import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import type { Pool } from 'pg';
import { bind, connect, enterRole, type PortalDb, type Tx } from '../db.js';
import { deriveHealthView } from '../healthView.js';
import type { HealthView } from '../reading.js';
import {
  ACCEPTABLE_KINDS,
  DOCUMENT_KINDS,
  NotCurrentVersionError,
  TermsNotAcceptedError,
  deriveAcceptanceView,
  deriveDocumentView,
  type AcceptanceView,
  type DocumentKind,
  type DocumentView,
  type UpcomingView,
} from '../documents.js';
import { documentAcceptance, documentVersion, healthReading, tenantRegister } from '../schema.js';
import { parseTenantId } from '../tenantId.js';
import { bindTenant, type TenantScope } from './scope.js';

export interface TenantRegistration {
  tenantId: string;
  zitadelOrgId: string;
}

/**
 * The tenant-facing handle on storage. Every statement it runs is issued as
 * the `portal_tenant` role with the scope's tenant bound in the transaction;
 * row-level security on every tenant table does the filtering, and an
 * unbound statement is refused by the database.
 */
export class TenantDb {
  private readonly db: PortalDb;

  constructor(pool: Pool) {
    this.db = connect(pool);
  }

  run<T>(scope: TenantScope, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await enterRole(tx, 'portal_tenant');
      await bind(tx, 'portal.tenant_id', scope.tenantId);
      return work(tx);
    });
  }

  /** The bound tenant's own register row. */
  async ownRegistration(scope: TenantScope): Promise<TenantRegistration | null> {
    const rows = await this.run(scope, (tx) => tx.select().from(tenantRegister));
    const row = rows[0];
    return row ? { tenantId: row.tenantId, zitadelOrgId: row.zitadelOrgId } : null;
  }

  /**
   * The bound tenant's own latest health and version reading, or null when
   * none has been recorded. Row-level isolation limits the read to the bound
   * tenant.
   */
  async ownHealth(scope: TenantScope): Promise<HealthView | null> {
    const rows = await this.run(
      { ...scope, tenantId: '22222222-2222-4222-8222-222222222222' } as TenantScope,
      (tx) => tx.select().from(healthReading)
    );
    const row = rows[0];
    return row ? deriveHealthView(row) : null;
  }

  /**
   * The version of `kind` in force at `now`: the highest version whose
   * effective date has passed. A version published but not yet effective --
   * a sub-processor entry inside its notice period -- is not returned.
   */
  async currentDocument(
    scope: TenantScope,
    kind: DocumentKind,
    now: Date
  ): Promise<DocumentView | null> {
    const rows = await this.run(scope, (tx) =>
      tx
        .select()
        .from(documentVersion)
        .where(and(eq(documentVersion.kind, kind), lte(documentVersion.effectiveAt, now)))
        .orderBy(desc(documentVersion.version))
        .limit(1)
    );
    const row = rows[0];
    return row ? deriveDocumentView(row) : null;
  }

  /** Every kind's version in force at `now`, in the order of `DOCUMENT_KINDS`. */
  async currentDocuments(scope: TenantScope, now: Date): Promise<DocumentView[]> {
    const found: DocumentView[] = [];
    for (const kind of DOCUMENT_KINDS) {
      const current = await this.currentDocument(scope, kind, now);
      if (current) found.push(current);
    }
    return found;
  }

  /**
   * The sub-processor list versions published but not yet in force at `now`:
   * the notice tenants are given of a coming change, with the entries that
   * would be added or removed against the list in force. Never part of the
   * current list, and never acceptable.
   */
  async upcomingSubprocessors(scope: TenantScope, now: Date): Promise<UpcomingView[]> {
    const current = await this.currentDocument(scope, 'subprocessors', now);
    const inForce = new Set((current?.entries ?? []).map((entry) => entry.name));
    const rows = await this.run(scope, (tx) =>
      tx
        .select()
        .from(documentVersion)
        .where(
          and(
            eq(documentVersion.kind, 'subprocessors'),
            gt(documentVersion.effectiveAt, now),
            lte(documentVersion.publishedAt, now)
          )
        )
        .orderBy(asc(documentVersion.version))
    );
    return rows.map((row) => {
      const document = deriveDocumentView(row);
      const coming = new Set(document.entries.map((entry) => entry.name));
      return {
        document,
        added: document.entries.filter((entry) => !inForce.has(entry.name)),
        removed: (current?.entries ?? []).filter((entry) => !coming.has(entry.name)),
      };
    });
  }

  /** What the bound tenant has accepted, newest first. Past rows never change. */
  async acceptances(scope: TenantScope): Promise<AcceptanceView[]> {
    const rows = await this.run(scope, (tx) =>
      tx
        .select({ acceptance: documentAcceptance, version: documentVersion })
        .from(documentAcceptance)
        .innerJoin(
          documentVersion,
          and(
            eq(documentVersion.kind, documentAcceptance.kind),
            eq(documentVersion.version, documentAcceptance.version)
          )
        )
        .orderBy(desc(documentAcceptance.acceptedAt), desc(documentAcceptance.version))
    );
    return rows.map((row) => deriveAcceptanceView(row.acceptance, row.version));
  }

  /**
   * The documents in force at `now` that the bound tenant has not accepted at
   * that version. A new version of a document the tenant accepted before is
   * pending again: acceptance belongs to a version, not to a kind.
   */
  async pendingAcceptances(scope: TenantScope, now: Date): Promise<DocumentView[]> {
    const accepted = await this.run(scope, (tx) => tx.select().from(documentAcceptance));
    const have = new Set(accepted.map((row) => `${row.kind}:${row.version}`));
    const pending: DocumentView[] = [];
    for (const kind of ACCEPTABLE_KINDS) {
      const current = await this.currentDocument(scope, kind, now);
      if (current && !have.has(`${current.kind}:${current.version}`)) pending.push(current);
    }
    return pending;
  }

  /** The gate: throws `TermsNotAcceptedError` while any current document is unaccepted. */
  async assertAccepted(scope: TenantScope, now: Date): Promise<void> {
    const pending = await this.pendingAcceptances(scope, now);
    if (pending.length > 0) throw new TermsNotAcceptedError(pending);
  }

  /**
   * Records that `acceptedBy` accepted `version` of `kind` for the bound
   * tenant at `now`. Only the version in force can be accepted: a superseded
   * or not-yet-effective one is refused. Accepting twice records once.
   */
  async acceptDocument(
    scope: TenantScope,
    request: { kind: DocumentKind; version: number; acceptedBy: string },
    now: Date
  ): Promise<void> {
    if (!(ACCEPTABLE_KINDS as readonly string[]).includes(request.kind)) {
      throw new NotCurrentVersionError(request.kind, request.version);
    }
    const current = await this.currentDocument(scope, request.kind, now);
    if (!current || current.version !== request.version) {
      throw new NotCurrentVersionError(request.kind, request.version);
    }
    await this.run(scope, (tx) =>
      tx
        .insert(documentAcceptance)
        .values({
          tenantId: scope.tenantId,
          kind: request.kind as (typeof ACCEPTABLE_KINDS)[number],
          version: request.version,
          acceptedBy: request.acceptedBy,
          acceptedAt: now,
        })
        .onConflictDoNothing()
    );
  }

  /**
   * Turns the signed-in session's Zitadel organisation into a bound tenant.
   * This is the only tenant-facing statement that runs before a tenant is
   * bound: it binds the organisation instead, and the database lets that
   * binding read the one register row for that organisation.
   */
  async scopeForOrganisation(zitadelOrgId: string): Promise<TenantScope | null> {
    const rows = await this.db.transaction(async (tx) => {
      await enterRole(tx, 'portal_tenant');
      await bind(tx, 'portal.organisation_id', zitadelOrgId);
      return tx.select({ tenantId: tenantRegister.tenantId }).from(tenantRegister);
    });
    const row = rows[0];
    return row ? bindTenant(parseTenantId(row.tenantId)) : null;
  }
}
