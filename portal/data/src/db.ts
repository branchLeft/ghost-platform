import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema.js';

export type PortalDb = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<PortalDb['transaction']>[0]>[0];

export function connect(pool: Pool): PortalDb {
  return drizzle(pool, { schema });
}

export type PortalRole = 'portal_tenant' | 'portal_owner';

/**
 * Drops the transaction to one of the two portal roles. The role is local to
 * the transaction, so a pooled connection never carries it to the next caller.
 */
export async function enterRole(tx: Tx, role: PortalRole): Promise<void> {
  await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
}

export type BindingKey = 'portal.tenant_id' | 'portal.organisation_id';

/**
 * Binds a value to the transaction for the policies to read. Local, so it
 * dies at commit or rollback with the role.
 */
export async function bind(tx: Tx, key: BindingKey, value: string): Promise<void> {
  await tx.execute(sql`SELECT set_config(${key}, ${value}, true)`);
}
