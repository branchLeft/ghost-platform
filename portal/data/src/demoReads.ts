import { asc, desc, eq } from 'drizzle-orm';
import type { Tx } from './db.js';
import {
  deriveEventView,
  type DemoEventView,
  type DemoState,
  type DemoSummary,
  type HostnameView,
} from './demoLifecycle.js';
import { demoStateEvent, hostnameRegister, hostnameRetirement } from './schema.js';

/** The demo's latest row: its current state and term; undefined when it was never begun. */
export async function latestEvent(tx: Tx, demoId: string): Promise<DemoEventView | undefined> {
  const [row] = await tx
    .select()
    .from(demoStateEvent)
    .where(eq(demoStateEvent.demoId, demoId))
    .orderBy(desc(demoStateEvent.sequence))
    .limit(1);
  return row === undefined ? undefined : deriveEventView(row);
}

/** Every transition of one demo, oldest first. */
export async function eventsOf(tx: Tx, demoId: string): Promise<DemoEventView[]> {
  const rows = await tx
    .select()
    .from(demoStateEvent)
    .where(eq(demoStateEvent.demoId, demoId))
    .orderBy(asc(demoStateEvent.sequence));
  return rows.map(deriveEventView);
}

/** The label allocated to a demo; null before it has one. */
export async function hostnameOf(tx: Tx, demoId: string): Promise<string | null> {
  const [row] = await tx
    .select({ label: hostnameRegister.label })
    .from(hostnameRegister)
    .where(eq(hostnameRegister.demoId, demoId));
  return row?.label ?? null;
}

/** Every demo with its current state, term and hostname, ordered by demo id. */
export async function listDemos(tx: Tx): Promise<DemoSummary[]> {
  const latest = await tx
    .selectDistinctOn([demoStateEvent.demoId])
    .from(demoStateEvent)
    .orderBy(asc(demoStateEvent.demoId), desc(demoStateEvent.sequence));
  const labels = new Map(
    (await tx.select().from(hostnameRegister)).map((row) => [row.demoId, row.label])
  );
  return latest.map((row) => ({
    demoId: row.demoId,
    state: row.toState as DemoState,
    leaseIssuedAt: row.leaseIssuedAt,
    leaseEndsAt: row.leaseEndsAt,
    hostname: labels.get(row.demoId) ?? null,
  }));
}

/** Every label ever allocated, oldest first, with its retirement when it has one. */
export async function listHostnames(tx: Tx): Promise<HostnameView[]> {
  const rows = await tx
    .select({ register: hostnameRegister, retiredAt: hostnameRetirement.retiredAt })
    .from(hostnameRegister)
    .leftJoin(hostnameRetirement, eq(hostnameRetirement.label, hostnameRegister.label))
    .orderBy(asc(hostnameRegister.allocatedAt), asc(hostnameRegister.label));
  return rows.map((row) => ({
    label: row.register.label,
    demoId: row.register.demoId,
    allocatedAt: row.register.allocatedAt,
    retiredAt: row.retiredAt,
  }));
}
