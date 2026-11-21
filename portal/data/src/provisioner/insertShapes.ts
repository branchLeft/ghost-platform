import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { portal } from '../schema.js';

// The provisioner role holds INSERT by column on the three tables it writes
// (the manifest's column grants), and none on the timestamp the database sets
// for each row: `recorded_at`, `allocated_at` and `retired_at`. An INSERT that
// names a column the role has no privilege on is refused, and that includes
// writing the column's DEFAULT, which the ORM does for every column an insert
// leaves out. So the provisioner inserts through these shapes, which carry the
// granted columns and no other; the database then fills the rest itself.
//
// They are not the schema: the migrations come from `../schema.js` alone, and
// the test suite holds each shape to that table minus the stamp.

/** `portal.demo_state_event` as the provisioner may write it: every column but `recorded_at`. */
export const demoStateEventInsert = portal.table('demo_state_event', {
  demoId: uuid('demo_id').notNull(),
  sequence: integer('sequence').notNull(),
  previousSequence: integer('previous_sequence'),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  leaseIssuedAt: timestamp('lease_issued_at', { withTimezone: true }),
  leaseEndsAt: timestamp('lease_ends_at', { withTimezone: true }),
  extensionDays: integer('extension_days').notNull().default(0),
});

/** `portal.hostname_register` as the provisioner may write it: every column but `allocated_at`. */
export const hostnameRegisterInsert = portal.table('hostname_register', {
  label: text('label').primaryKey(),
  demoId: uuid('demo_id').notNull().unique(),
});

/** `portal.hostname_retirement` as the provisioner may write it: every column but `retired_at`. */
export const hostnameRetirementInsert = portal.table('hostname_retirement', {
  label: text('label').primaryKey(),
});
