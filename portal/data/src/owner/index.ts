import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  TenantNotBillableError,
  deriveBillingView,
  parseBillingReference,
  parsePaymentState,
  type BillingView,
} from '../billing.js';
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
import {
  eventsOf,
  hostnameOf,
  listDemos,
  listHostnames,
  listRequests,
  requestOf,
} from '../demoReads.js';
import type { DemoRequestView } from '../demoRequest.js';
import type { DemoEventView, DemoSummary, HostnameView } from '../demoLifecycle.js';
import {
  documentVersion,
  healthReading,
  supportAccessReading,
  supportAccessRequest,
  tenantBilling,
  tenantRegister,
} from '../schema.js';
import {
  assertSupportReading,
  type SupportAccessReading,
  type SupportRequestStatus,
  type SupportRequestView,
} from '../supportAccess.js';

export { MalformedScrapeError, type HealthView } from '../reading.js';
export { InvalidPublicationError, SUBPROCESSOR_NOTICE_DAYS } from '../documents.js';
export { InvalidTenantKindError, TENANT_KINDS, type TenantKind } from '../tenantKind.js';
export type { DemoEventView, DemoSummary, HostnameView } from '../demoLifecycle.js';
export type { DemoRequestView } from '../demoRequest.js';
export {
  InvalidSupportReadingError,
  SUPPORT_READING_FRESH_SECONDS,
  SUPPORT_REQUEST_STATUSES,
  type SupportAccessReading,
  type SupportRequestStatus,
  type SupportRequestView,
} from '../supportAccess.js';
import { parseTenantId } from '../tenantId.js';
import { parseTenantKind } from '../tenantKind.js';
import { normaliseTenantName, TenantNameTakenError } from '../tenantName.js';
import { readDatabaseError, UNIQUE_VIOLATION } from '../databaseError.js';
import { TenantNotRegisteredError, type TenantRegistration } from '../tenant/session.js';

export { InvalidTenantNameError, TenantNameTakenError } from '../tenantName.js';
export {
  BILLING_REFERENCE_PATTERN,
  InvalidBillingReferenceError,
  InvalidPaymentStateError,
  PAYMENT_STATES,
  TenantNotBillableError,
  type BillingView,
  type PaymentState,
} from '../billing.js';
export { TenantNotRegisteredError } from '../tenant/session.js';

/** A tenant being registered: the register row, plus the name it signed up under. */
export interface NewTenantRegistration extends TenantRegistration {
  /** Absent for a demo slot, which has no customer name. */
  tenantName?: string;
}

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

  /**
   * Registers a tenant with its kind. The kind is required and parsed
   * strictly before the insert: an absent or unrecognised one is refused with
   * `InvalidTenantKindError`, never defaulted, and the table refuses it again
   * if this check is ever bypassed. Only this role can write a kind.
   *
   * This is the point where a sign-up is accepted, so it is where a taken name
   * is refused. A name, when given, is normalised the way the tenant's slug is
   * (`InvalidTenantNameError` if it is not a slug) and stored; a second tenant
   * under the same normalised name is refused with `TenantNameTakenError`. The
   * refusal comes from the table's unique constraint, so two sign-ups racing
   * for one name cannot both win, and it carries no name.
   */
  async registerTenant(registration: NewTenantRegistration): Promise<void> {
    const tenantId = parseTenantId(registration.tenantId);
    const kind = parseTenantKind(registration.kind);
    const tenantName =
      registration.tenantName === undefined ? null : normaliseTenantName(registration.tenantName);
    try {
      await this.run(async (tx) => {
        await tx
          .insert(tenantRegister)
          .values({ tenantId, zitadelOrgId: registration.zitadelOrgId, kind, tenantName });
      });
    } catch (error) {
      const refused = readDatabaseError(error);
      if (
        refused?.code === UNIQUE_VIOLATION &&
        refused.constraint === 'tenant_register_tenant_name_unique'
      ) {
        throw new TenantNameTakenError();
      }
      throw error;
    }
  }

  async listTenants(): Promise<TenantRegistration[]> {
    return this.run(async (tx) => {
      const rows = await tx
        .select()
        .from(tenantRegister)
        .orderBy(asc(tenantRegister.createdAt), asc(tenantRegister.tenantId));
      return rows.map((row) => ({
        tenantId: row.tenantId,
        zitadelOrgId: row.zitadelOrgId,
        kind: parseTenantKind(row.kind),
      }));
    });
  }

  /**
   * Each registered tenant that has a name, as that name and its id. The name
   * is the slug of the tenant's stack, which is the label a host's reports
   * carry, so this is how a host's reading finds its tenant. A tenant with no
   * name (a demo slot, tenant zero) is left out: nothing a host says can reach it.
   */
  async listTenantSlugs(): Promise<Array<{ slug: string; tenantId: string }>> {
    return this.run(async (tx) => {
      const rows = await tx
        .select({ tenantId: tenantRegister.tenantId, tenantName: tenantRegister.tenantName })
        .from(tenantRegister)
        .orderBy(asc(tenantRegister.createdAt), asc(tenantRegister.tenantId));
      return rows.flatMap((row) =>
        row.tenantName === null ? [] : [{ slug: row.tenantName, tenantId: row.tenantId }]
      );
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
   * Sets a real tenant's payment state, creating its billing record (with no
   * reference) if it has none. The state is parsed before a statement runs and
   * the table refuses one outside the list again. `stateChangedAt` moves only
   * when the state does, so setting the state a tenant already has changes
   * nothing. A tenant that is not registered is refused with
   * `TenantNotRegisteredError`, a demo slot with `TenantNotBillableError`.
   */
  async setPaymentState(tenantId: string, state: string): Promise<BillingView> {
    const id = parseTenantId(tenantId);
    const paymentState = parsePaymentState(state);
    return this.run(async (tx) => {
      await assertBillable(tx, id);
      const [row] = await tx
        .insert(tenantBilling)
        .values({ tenantId: id, paymentState })
        .onConflictDoUpdate({
          target: tenantBilling.tenantId,
          set: {
            paymentState,
            stateChangedAt: sql`CASE WHEN ${tenantBilling.paymentState} IS DISTINCT FROM excluded.payment_state THEN now() ELSE ${tenantBilling.stateChangedAt} END`,
          },
        })
        .returning();
      return deriveBillingView(row!);
    });
  }

  /**
   * Records, replaces or (given null) clears a real tenant's billing
   * reference: the opaque reference into the owner's invoicing tool. A value
   * that is not an opaque reference, a card-number-like one included, is
   * refused with `InvalidBillingReferenceError` before a statement runs and
   * again by the table. A tenant with no billing record is given one as
   * `unpaid`; an existing record keeps its payment state.
   */
  async setBillingReference(tenantId: string, reference: string | null): Promise<BillingView> {
    const id = parseTenantId(tenantId);
    const billingReference = reference === null ? null : parseBillingReference(reference);
    return this.run(async (tx) => {
      await assertBillable(tx, id);
      const [row] = await tx
        .insert(tenantBilling)
        .values({ tenantId: id, billingReference, paymentState: 'unpaid' })
        .onConflictDoUpdate({ target: tenantBilling.tenantId, set: { billingReference } })
        .returning();
      return deriveBillingView(row!);
    });
  }

  /** One tenant's billing record; null when it has none. */
  async billingOf(tenantId: string): Promise<BillingView | null> {
    const id = parseTenantId(tenantId);
    return this.run(async (tx) => {
      const [row] = await tx.select().from(tenantBilling).where(eq(tenantBilling.tenantId, id));
      return row ? deriveBillingView(row) : null;
    });
  }

  /** Every billing record, by tenant id: the console's read. It writes nothing. */
  async listBilling(): Promise<BillingView[]> {
    return this.run(async (tx) => {
      const rows = await tx.select().from(tenantBilling).orderBy(asc(tenantBilling.tenantId));
      return rows.map(deriveBillingView);
    });
  }

  /** Every overdue tenant, the longest overdue first: the console's list. */
  async listOverdue(): Promise<BillingView[]> {
    return this.run(async (tx) => {
      const rows = await tx
        .select()
        .from(tenantBilling)
        .where(eq(tenantBilling.paymentState, 'overdue'))
        .orderBy(asc(tenantBilling.stateChangedAt), asc(tenantBilling.tenantId));
      return rows.map(deriveBillingView);
    });
  }

  /**
   * Replaces a tenant's support-access reading with what the host's read-only
   * report said at `observedAt`. A state or lane outside the closed lists is
   * refused before a statement runs, and the table refuses it again.
   */
  async recordSupportAccess(
    tenantId: string,
    reading: SupportAccessReading,
    observedAt: Date
  ): Promise<void> {
    const id = parseTenantId(tenantId);
    assertSupportReading(reading);
    const values = {
      state: reading.state,
      lane: reading.lane,
      grantedAt: reading.grantedAt,
      deadlineAt: reading.deadline,
      observedAt,
    };
    await this.run(async (tx) => {
      await tx
        .insert(supportAccessReading)
        .values({ tenantId: id, ...values })
        .onConflictDoUpdate({ target: supportAccessReading.tenantId, set: values });
    });
  }

  /**
   * Every support-access request: open ones first, then dealt-with ones, each
   * group oldest first. The console's queue; it has no paging.
   */
  async listSupportRequests(): Promise<SupportRequestView[]> {
    return this.run(async (tx) => {
      const rows = await tx
        .select()
        .from(supportAccessRequest)
        .orderBy(
          desc(sql`${supportAccessRequest.status} = 'open'`),
          asc(supportAccessRequest.requestedAt),
          asc(supportAccessRequest.tenantId)
        );
      return rows.map((row) => ({
        tenantId: row.tenantId,
        requestedAt: row.requestedAt,
        status: row.status as SupportRequestStatus,
      }));
    });
  }

  /**
   * Marks a tenant's open request dealt with. It returns whether one was open:
   * a second call, or a tenant that never asked, changes nothing and returns
   * false. The row stays; nothing deletes a request.
   */
  async markSupportRequestDealtWith(tenantId: string): Promise<boolean> {
    const id = parseTenantId(tenantId);
    const changed = await this.run((tx) =>
      tx
        .update(supportAccessRequest)
        .set({ status: 'dealt_with' })
        .where(and(eq(supportAccessRequest.tenantId, id), eq(supportAccessRequest.status, 'open')))
        .returning({ tenantId: supportAccessRequest.tenantId })
    );
    return changed.length > 0;
  }

  /** Every demo with its current state, term and hostname: the console's read. It writes nothing. */
  listDemos(): Promise<DemoSummary[]> {
    return this.run(listDemos);
  }

  /** One demo's history, oldest transition first. */
  demoHistory(demoId: string): Promise<DemoEventView[]> {
    return this.run((tx) => eventsOf(tx, demoId));
  }

  /** The label allocated to a demo; null before it has one. */
  demoHostname(demoId: string): Promise<string | null> {
    return this.run((tx) => hostnameOf(tx, demoId));
  }

  /** Every demo request, oldest first. */
  listRequests(): Promise<DemoRequestView[]> {
    return this.run(listRequests);
  }

  /** One demo's request; undefined when there is none. */
  demoRequest(demoId: string): Promise<DemoRequestView | undefined> {
    return this.run((tx) => requestOf(tx, demoId));
  }

  /** The hostname register in full, each label with its retirement when it has one. */
  listHostnames(): Promise<HostnameView[]> {
    return this.run(listHostnames);
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

/** Refuses a tenant that is not registered or is a demo slot: only a real tenant is billed. */
async function assertBillable(tx: Tx, tenantId: string): Promise<void> {
  const [row] = await tx
    .select({ kind: tenantRegister.kind })
    .from(tenantRegister)
    .where(eq(tenantRegister.tenantId, tenantId));
  if (row === undefined) throw new TenantNotRegisteredError();
  if (row.kind !== 'REAL') throw new TenantNotBillableError();
}

/** Whether the database refused a row for taking effect inside its notice. */
function isNoticeRefusal(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | null)?.cause;
  return cause?.code === '23514' && cause.constraint === 'document_version_notice_elapsed';
}
