import { sql } from 'drizzle-orm';
import type { Fixture } from './helpers.js';

/**
 * Runs `probe` with the erasure table's moment check removed, so a row can say
 * `key_destroyed` with no moment (a row the table refuses), and puts the check
 * back and the row right whatever the probe does.
 */
export async function whileMomentCheckDropped(
  fixture: Fixture,
  probe: () => Promise<void>
): Promise<void> {
  await fixture.adminDb.execute(
    sql`ALTER TABLE portal.tenant_erasure_request DROP CONSTRAINT tenant_erasure_request_destroyed_moment`
  );
  try {
    await probe();
  } finally {
    await fixture.adminDb.execute(
      sql`UPDATE portal.tenant_erasure_request SET status = 'requested', key_destroyed_at = NULL`
    );
    await fixture.adminDb.execute(
      sql`ALTER TABLE portal.tenant_erasure_request ADD CONSTRAINT tenant_erasure_request_destroyed_moment CHECK ((status = 'requested' AND key_destroyed_at IS NULL) OR (status = 'key_destroyed' AND key_destroyed_at IS NOT NULL))`
    );
  }
}

/** Stores a row that says `key_destroyed` and carries no moment. */
export async function markDestroyedWithoutMoment(fixture: Fixture): Promise<void> {
  await fixture.adminDb.execute(
    sql`UPDATE portal.tenant_erasure_request SET status = 'key_destroyed', key_destroyed_at = NULL`
  );
}
