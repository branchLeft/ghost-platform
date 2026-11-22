import { healthReading } from '../src/schema.js';
import type { Fixture } from './helpers.js';

/** Administrator-side statements the health collector's tests run against the fixture database. */

/** Removes every stored reading, so a test starts from no reading at all. */
export async function deleteReadings(fixture: Fixture): Promise<void> {
  await fixture.adminDb.delete(healthReading);
}

/** How many readings are stored, whoever they are for. */
export async function readingCount(fixture: Fixture): Promise<number> {
  const rows = await fixture.adminDb
    .select({ tenantId: healthReading.tenantId })
    .from(healthReading);
  return rows.length;
}
