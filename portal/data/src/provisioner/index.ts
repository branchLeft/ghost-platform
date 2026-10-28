import { and, count, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { connect, enterRole, type PortalDb, type Tx } from '../db.js';
import { FOREIGN_KEY_VIOLATION, UNIQUE_VIOLATION, readDatabaseError } from '../databaseError.js';
import {
  ConcurrentTransitionError,
  DemoExistsError,
  DemoHostnameExistsError,
  EXTENSION_DAYS,
  HostnameAllocationRefusedError,
  HostnameRetiredError,
  HostnameReusedError,
  LEASE_DAYS,
  UnknownDemoError,
  UnknownHostnameError,
  assertExtensionAllowed,
  assertTransitionAllowed,
  deriveEventView,
  generateLabel,
  parseDemoId,
  type DemoEventView,
  type DemoState,
} from '../demoLifecycle.js';
import { eventsOf, hostnameOf, latestEvent } from '../demoReads.js';
import { demoStateEvent, hostnameRegister, hostnameRetirement } from '../schema.js';

export * from '../demoLifecycle.js';

/** The two columns of a term: what is written to them, as SQL the database evaluates. */
interface Term {
  issuedAt: SQL;
  endsAt: SQL;
}

/**
 * The only writer of the demo's state events and the hostname register: a
 * separate entry point on purpose, used by the control-plane lifecycle worker
 * alone. The pool it takes is connected as a login that is a member of
 * `portal_provisioner` alone, a role that can insert into these tables and
 * neither update nor delete (see the README). No time is ever taken from a
 * caller: every term and every record time is the database's clock.
 */
export class ProvisionerDb {
  private readonly db: PortalDb;

  /** `newLabel` is the seam for a test; by default a label comes from the random source. */
  constructor(
    pool: Pool,
    private readonly newLabel: () => string = generateLabel
  ) {
    this.db = connect(pool);
  }

  /** One unit of work as the `portal_provisioner` role. */
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await enterRole(tx, 'portal_provisioner');
      return work(tx);
    });
  }

  /**
   * Begins a demo at VERIFIED. The id is the demo's opaque id, made by the
   * caller.
   *
   * @throws InvalidDemoIdError
   * @throws DemoExistsError
   */
  async beginDemo(demoId: string): Promise<DemoEventView> {
    const id = parseDemoId(demoId);
    return this.run(async (tx) => {
      try {
        const [row] = await tx
          .insert(demoStateEvent)
          .values({ demoId: id, sequence: 1, toState: 'VERIFIED' })
          .returning();
        return deriveEventView(row!);
      } catch (error) {
        if (readDatabaseError(error)?.code === UNIQUE_VIOLATION) throw new DemoExistsError(id);
        throw error;
      }
    });
  }

  /**
   * Moves a demo to `to`. Entering PROVISIONING issues its term: seven days
   * from the database's clock now. Every other transition carries the term
   * on unchanged, which is what keeps a rebuild on the same end as before.
   * An extension is not a transition made here: see `extend`.
   *
   * @throws UnknownDemoError
   * @throws ForbiddenTransitionError
   * @throws ConcurrentTransitionError
   */
  async transition(demoId: string, to: DemoState): Promise<DemoEventView> {
    return this.run(async (tx) => {
      const latest = await this.latestOrThrow(tx, demoId);
      assertTransitionAllowed({ state: latest.toState, origin: latest.fromState }, to);
      const term = to === 'PROVISIONING' ? issuedNow() : carried(tx, latest);
      return this.append(tx, latest, to, term, 0);
    });
  }

  /**
   * The one self-service extension: LIVE or EXPIRING to EXTENDED, with the end
   * of the term moved on by 14 days and nothing else about the term changed.
   *
   * @throws UnknownDemoError
   * @throws ExtensionRefusedError
   * @throws ConcurrentTransitionError
   */
  async extend(demoId: string): Promise<DemoEventView> {
    return this.run(async (tx) => {
      const latest = await this.latestOrThrow(tx, demoId);
      const [taken] = await tx
        .select({ total: count() })
        .from(demoStateEvent)
        .where(and(eq(demoStateEvent.demoId, demoId), gt(demoStateEvent.extensionDays, 0)));
      assertExtensionAllowed(demoId, latest.toState, taken?.total ?? 0);
      const term = carried(tx, latest);
      const moved: Term = {
        issuedAt: term.issuedAt,
        endsAt: sql`${term.endsAt} + make_interval(hours => ${EXTENSION_DAYS * 24})`,
      };
      return this.append(tx, latest, 'EXTENDED', moved, EXTENSION_DAYS);
    });
  }

  /**
   * Allocates the demo's one hostname while it is CLAIMED, before its
   * descriptor is signed, and returns the label. The label is random and the
   * allocation time the database's.
   *
   * @throws UnknownDemoError
   * @throws HostnameAllocationRefusedError
   * @throws DemoHostnameExistsError
   * @throws HostnameReusedError
   */
  async allocateHostname(demoId: string): Promise<string> {
    return this.run(async (tx) => {
      const latest = await this.latestOrThrow(tx, demoId);
      if (latest.toState !== 'CLAIMED') {
        throw new HostnameAllocationRefusedError(demoId, latest.toState);
      }
      const label = this.newLabel();
      try {
        await tx.insert(hostnameRegister).values({ label, demoId });
      } catch (error) {
        const found = readDatabaseError(error);
        if (found?.code === UNIQUE_VIOLATION && found.constraint === 'hostname_register_pkey') {
          throw new HostnameReusedError(label);
        }
        if (found?.code === UNIQUE_VIOLATION) throw new DemoHostnameExistsError(demoId);
        throw error;
      }
      return label;
    });
  }

  /**
   * Retires a hostname by appending its retirement; the register row is
   * untouched.
   *
   * @throws UnknownHostnameError
   * @throws HostnameRetiredError
   */
  async retireHostname(label: string): Promise<void> {
    await this.run(async (tx) => {
      try {
        await tx.insert(hostnameRetirement).values({ label });
      } catch (error) {
        const found = readDatabaseError(error);
        if (found?.code === FOREIGN_KEY_VIOLATION) throw new UnknownHostnameError(label);
        if (found?.code === UNIQUE_VIOLATION) throw new HostnameRetiredError(label);
        throw error;
      }
    });
  }

  /** The demo's current state and term: its latest row; undefined when it was never begun. */
  currentState(demoId: string): Promise<DemoEventView | undefined> {
    return this.run((tx) => latestEvent(tx, demoId));
  }

  history(demoId: string): Promise<DemoEventView[]> {
    return this.run((tx) => eventsOf(tx, demoId));
  }

  hostname(demoId: string): Promise<string | null> {
    return this.run((tx) => hostnameOf(tx, demoId));
  }

  private async latestOrThrow(tx: Tx, demoId: string): Promise<DemoEventView> {
    const latest = await latestEvent(tx, demoId);
    if (latest === undefined) throw new UnknownDemoError(demoId);
    return latest;
  }

  private async append(
    tx: Tx,
    latest: DemoEventView,
    to: DemoState,
    term: Term,
    extensionDays: number
  ): Promise<DemoEventView> {
    try {
      const [row] = await tx
        .insert(demoStateEvent)
        .values({
          demoId: latest.demoId,
          sequence: latest.sequence + 1,
          previousSequence: latest.sequence,
          fromState: latest.toState,
          toState: to,
          leaseIssuedAt: term.issuedAt,
          leaseEndsAt: term.endsAt,
          extensionDays,
        })
        .returning();
      return deriveEventView(row!);
    } catch (error) {
      if (readDatabaseError(error)?.code === UNIQUE_VIOLATION) {
        throw new ConcurrentTransitionError(latest.demoId);
      }
      throw error;
    }
  }
}

/** A new term: starts at the database's clock and runs the seven days. */
function issuedNow(): Term {
  return {
    issuedAt: sql`now()`,
    endsAt: sql`now() + make_interval(hours => ${LEASE_DAYS * 24})`,
  };
}

/** The previous row's own values, read by the statement that inserts, so no precision is lost on the way. */
function carried(tx: Tx, latest: DemoEventView): Term {
  const previous = (column: PgColumn): SQL =>
    sql`(${tx
      .select({ value: column })
      .from(demoStateEvent)
      .where(
        and(eq(demoStateEvent.demoId, latest.demoId), eq(demoStateEvent.sequence, latest.sequence))
      )})`;
  return {
    issuedAt: previous(demoStateEvent.leaseIssuedAt),
    endsAt: previous(demoStateEvent.leaseEndsAt),
  };
}
