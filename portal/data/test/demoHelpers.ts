import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias, integer, pgSchema, text, type PgColumn } from 'drizzle-orm/pg-core';
import { readDatabaseError, type DatabaseErrorInfo } from '../src/databaseError.js';
import type { PortalDb } from '../src/db.js';
import { demoStateEvent, hostnameRegister } from '../src/schema.js';
import { FIXTURE_DATABASE } from './helpers.js';

// Reads and writes made as the database's administrator, through the ORM, so
// a test can look at what is stored (microseconds kept) and plant the rows
// the typed operations refuse to make, to prove the table refuses them too.

const asText = (column: PgColumn): ReturnType<typeof sql<string | null>> =>
  sql<string | null>`${column}::text`;

/** One stored event row with every column as the database prints it. */
export interface StoredEvent {
  demo_id: string | null;
  sequence: number;
  previous_sequence: number | null;
  from_state: string | null;
  to_state: string;
  lease_issued_at: string | null;
  lease_ends_at: string | null;
  extension_days: number;
  recorded_at: string | null;
}

export function storedEventRows(db: PortalDb, demoId: string): Promise<StoredEvent[]> {
  return db
    .select({
      demo_id: asText(demoStateEvent.demoId),
      sequence: demoStateEvent.sequence,
      previous_sequence: demoStateEvent.previousSequence,
      from_state: demoStateEvent.fromState,
      to_state: demoStateEvent.toState,
      lease_issued_at: asText(demoStateEvent.leaseIssuedAt),
      lease_ends_at: asText(demoStateEvent.leaseEndsAt),
      extension_days: demoStateEvent.extensionDays,
      recorded_at: asText(demoStateEvent.recordedAt),
    })
    .from(demoStateEvent)
    .where(eq(demoStateEvent.demoId, demoId))
    .orderBy(asc(demoStateEvent.sequence));
}

/** Register rows as stored, one demo's or, with no demo, all of them by label. */
export function storedRegisterRows(
  db: PortalDb,
  demoId?: string
): Promise<{ label: string; demo_id: string | null; allocated_at: string | null }[]> {
  return db
    .select({
      label: hostnameRegister.label,
      demo_id: asText(hostnameRegister.demoId),
      allocated_at: asText(hostnameRegister.allocatedAt),
    })
    .from(hostnameRegister)
    .where(demoId === undefined ? undefined : eq(hostnameRegister.demoId, demoId))
    .orderBy(asc(hostnameRegister.label));
}

/** Seconds from one stored column to another on the same row, computed by the database. */
export async function secondsBetween(
  db: PortalDb,
  demoId: string,
  sequence: number,
  from: PgColumn,
  to: PgColumn
): Promise<number> {
  const [row] = await db
    .select({ seconds: sql<number>`extract(epoch from ${to} - ${from})`.mapWith(Number) })
    .from(demoStateEvent)
    .where(and(eq(demoStateEvent.demoId, demoId), eq(demoStateEvent.sequence, sequence)));
  return row!.seconds;
}

/** Seconds the end of the term moved between two rows of one demo. */
export async function endShiftSeconds(
  db: PortalDb,
  demoId: string,
  earlier: number,
  later: number
): Promise<number> {
  const first = alias(demoStateEvent, 'first');
  const second = alias(demoStateEvent, 'second');
  const [row] = await db
    .select({
      seconds:
        sql<number>`extract(epoch from ${second.leaseEndsAt} - ${first.leaseEndsAt})`.mapWith(
          Number
        ),
    })
    .from(first)
    .innerJoin(
      second,
      and(eq(first.demoId, second.demoId), eq(first.sequence, earlier), eq(second.sequence, later))
    )
    .where(eq(first.demoId, demoId));
  return row!.seconds;
}

/** The database's own clock now, in milliseconds. */
export async function databaseClock(db: PortalDb): Promise<number> {
  const result = await db.execute<{ now: string }>(
    sql`select extract(epoch from clock_timestamp()) * 1000 as now`
  );
  return Number(result.rows[0]!.now);
}

/** What the database refused a statement with; undefined when it was accepted. */
export async function refusal(work: PromiseLike<unknown>): Promise<DatabaseErrorInfo | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    const found = readDatabaseError(error);
    if (found === undefined) throw error;
    return found;
  }
}

const pgStatActivity = pgSchema('pg_catalog').table('pg_stat_activity', {
  waitEventType: text('wait_event_type'),
  datname: text('datname'),
});

/** Waits until some session on the fixture database is blocked on a lock, or gives up after about five seconds. */
export async function waitForLockWait(db: PortalDb): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await db
      .select({ datname: pgStatActivity.datname })
      .from(pgStatActivity)
      .where(
        and(eq(pgStatActivity.waitEventType, 'Lock'), eq(pgStatActivity.datname, FIXTURE_DATABASE))
      );
    if (waiting.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const informationColumns = pgSchema('information_schema').table('columns', {
  tableSchema: text('table_schema'),
  tableName: text('table_name'),
  columnName: text('column_name'),
  dataType: text('data_type'),
  ordinalPosition: integer('ordinal_position'),
});

/** The portal columns of `tables` as `table.column type`, in table then column order. */
export async function portalColumns(db: PortalDb, tables: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({
      table: informationColumns.tableName,
      column: informationColumns.columnName,
      type: informationColumns.dataType,
    })
    .from(informationColumns)
    .where(
      and(
        eq(informationColumns.tableSchema, 'portal'),
        inArray(informationColumns.tableName, [...tables])
      )
    )
    .orderBy(asc(informationColumns.tableName), asc(informationColumns.ordinalPosition));
  return rows.map((row) => `${row.table}.${row.column} ${row.type}`);
}
