import { and, asc, count, desc, eq, getTableColumns, gt, lt, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { connect, enterRole, type PortalDb, type Tx } from '../db.js';
import {
  demoStateEventInsert,
  hostnameRegisterInsert,
  hostnameRetirementInsert,
} from './insertShapes.js';
import { FOREIGN_KEY_VIOLATION, UNIQUE_VIOLATION, readDatabaseError } from '../databaseError.js';
import {
  AdmissionRefusedError,
  ConcurrentTransitionError,
  DemoExistsError,
  DemoHostnameExistsError,
  EXTENSION_DAYS,
  HostnameAllocationRefusedError,
  HostnameRetiredError,
  HostnameReusedError,
  LEASE_DAYS,
  SLOT_COUNT,
  SLOT_HOLDING_STATES,
  UnknownDemoError,
  UnknownHostnameError,
  assertExtensionAllowed,
  assertTransitionAllowed,
  deriveEventView,
  generateLabel,
  parseDemoId,
  type Admission,
  type DemoEventView,
  type DemoState,
} from '../demoLifecycle.js';
import {
  countDemosIn,
  countFailedHoldingSlot,
  eventsOf,
  hostnameOf,
  latestEvent,
  requestOf,
} from '../demoReads.js';
import type { DemoRequestView } from '../demoRequest.js';
import { demoStateEvent } from '../schema.js';

export * from '../demoLifecycle.js';

/**
 * The advisory lock every admission takes, so that two requests cannot both
 * see a free slot and take the last one. The value is arbitrary: it only has to
 * be the same everywhere admission is decided. The lock is scoped to the
 * database and held to the end of the transaction.
 */
const ADMISSION_LOCK_KEY = 4_172_906_385;

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
          .insert(demoStateEventInsert)
          .values({ demoId: id, sequence: 1, toState: 'VERIFIED' })
          .returning(getTableColumns(demoStateEvent));
        return deriveEventView(row!);
      } catch (error) {
        if (readDatabaseError(error)?.code === UNIQUE_VIOLATION) throw new DemoExistsError(id);
        throw error;
      }
    });
  }

  /**
   * Decides, for a demo at VERIFIED whose request is recorded, whether the
   * request gets a slot or goes onto the waiting list, and records that as
   * its next state. A full house is an outcome, never an error: a request
   * that finds every slot held is a lead on the list, with the contact
   * details its recorded request already carries.
   *
   * It is CLAIMED only when fewer than `SLOT_COUNT` demos hold a slot (a
   * demo in a slot-holding state, or one FAILED whose hostname is not yet
   * retired: its slot has not been freed) and nobody is waiting, so a later request never passes an earlier one. The
   * decision is made under one advisory lock held to the end of the
   * transaction, so concurrent requests are decided one at a time: the
   * seventh can never also be given the sixth slot.
   *
   * @throws InvalidDemoIdError
   * @throws UnknownDemoError
   * @throws AdmissionRefusedError
   * @throws ConcurrentTransitionError
   */
  async admit(demoId: string): Promise<Admission> {
    const id = parseDemoId(demoId);
    return this.run(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`);
      const latest = await this.latestOrThrow(tx, id);
      if (latest.toState !== 'VERIFIED') throw new AdmissionRefusedError(id, 'state');
      if ((await requestOf(tx, id)) === undefined) throw new AdmissionRefusedError(id, 'request');
      // A demo that FAILED with its slot not yet freed still holds it: the
      // worker retires the hostname only once the slot is free.
      const holding =
        (await countDemosIn(tx, SLOT_HOLDING_STATES)) + (await countFailedHoldingSlot(tx));
      const waiting = await countDemosIn(tx, ['WAITING']);
      const state = holding < SLOT_COUNT && waiting === 0 ? 'CLAIMED' : 'WAITING';
      const event = await this.append(tx, latest, state, carried(tx, latest), 0);
      return { event, state, queuePosition: state === 'WAITING' ? waiting + 1 : null };
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
   * Sweeps demos left in PROVISIONING by a process killed before it could
   * record FAILED. Each demo whose PROVISIONING row was recorded more than
   * `staleAfterSeconds` ago, by the database's clock, is moved to FAILED. The
   * caller passes the provision timeout plus a margin. The hostname is left
   * unretired: the slot is not known to be free, so `admit` keeps counting it
   * until a person frees it. Each demo is decided in its own transaction,
   * which re-reads its latest row, so a demo that moved on meanwhile is left
   * alone. The loop that calls this is not built here.
   *
   * @returns the ids of the demos moved to FAILED
   * @throws RangeError when `staleAfterSeconds` is not a finite number of at least zero
   */
  async sweepStaleProvisioning(staleAfterSeconds: number): Promise<string[]> {
    if (!Number.isFinite(staleAfterSeconds) || staleAfterSeconds < 0) {
      throw new RangeError('staleAfterSeconds must be a finite number of at least zero');
    }
    const candidates = await this.run((tx) => staleProvisioningIds(tx, staleAfterSeconds));
    const swept: string[] = [];
    for (const demoId of candidates) {
      try {
        const done = await this.run(async (tx) => {
          if (!(await staleProvisioningIds(tx, staleAfterSeconds, demoId)).includes(demoId)) {
            return false;
          }
          const latest = await this.latestOrThrow(tx, demoId);
          assertTransitionAllowed({ state: latest.toState, origin: latest.fromState }, 'FAILED');
          await this.append(tx, latest, 'FAILED', carried(tx, latest), 0);
          return true;
        });
        if (done) swept.push(demoId);
      } catch (error) {
        // A demo that moved on between the read and the append is not ours to fail.
        if (error instanceof ConcurrentTransitionError) continue;
        throw error;
      }
    }
    return swept;
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
        await tx.insert(hostnameRegisterInsert).values({ label, demoId });
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
        await tx.insert(hostnameRetirementInsert).values({ label });
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

  /** The prospect's request the demo runs under; undefined when there is none. */
  request(demoId: string): Promise<DemoRequestView | undefined> {
    return this.run((tx) => requestOf(tx, demoId));
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
        .insert(demoStateEventInsert)
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
        .returning(getTableColumns(demoStateEvent));
      return deriveEventView(row!);
    } catch (error) {
      if (readDatabaseError(error)?.code === UNIQUE_VIOLATION) {
        throw new ConcurrentTransitionError(latest.demoId);
      }
      throw error;
    }
  }
}

/**
 * The demos whose latest row is PROVISIONING and was recorded more than
 * `staleAfterSeconds` ago by the database's clock; all of them, or only
 * `demoId` when given. Read inside the caller's transaction.
 */
async function staleProvisioningIds(
  tx: Tx,
  staleAfterSeconds: number,
  demoId?: string
): Promise<string[]> {
  const latest = tx
    .selectDistinctOn([demoStateEvent.demoId], {
      demoId: demoStateEvent.demoId,
      toState: demoStateEvent.toState,
      recordedAt: demoStateEvent.recordedAt,
    })
    .from(demoStateEvent)
    .orderBy(asc(demoStateEvent.demoId), desc(demoStateEvent.sequence))
    .as('latest');
  const rows = await tx
    .select({ demoId: latest.demoId })
    .from(latest)
    .where(
      and(
        eq(latest.toState, 'PROVISIONING'),
        lt(latest.recordedAt, sql`now() - make_interval(secs => ${staleAfterSeconds})`),
        demoId === undefined ? undefined : eq(latest.demoId, demoId)
      )
    );
  return rows.map((row) => row.demoId);
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
