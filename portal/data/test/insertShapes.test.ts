import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import { manifest } from '../provision/manifest.js';
import {
  demoStateEventInsert,
  hostnameRegisterInsert,
  hostnameRetirementInsert,
} from '../src/provisioner/insertShapes.js';
import { demoStateEvent, hostnameRegister, hostnameRetirement } from '../src/schema.js';

// The provisioner inserts through narrowed table shapes because the role holds
// INSERT by column. A shape that drifted from the schema or from the manifest's
// grant would fail only against a server, so it is held to both here.

const CASES = [
  ['portal.demo_state_event', demoStateEvent, demoStateEventInsert, 'recorded_at'],
  ['portal.hostname_register', hostnameRegister, hostnameRegisterInsert, 'allocated_at'],
  ['portal.hostname_retirement', hostnameRetirement, hostnameRetirementInsert, 'retired_at'],
] as const;

const names = (table: Parameters<typeof getTableColumns>[0]): string[] =>
  Object.values(getTableColumns(table))
    .map((column) => column.name)
    .sort();

describe.each(CASES)('the insert shape of %s', (identity, table, shape, stamp) => {
  it('is the schema table without its database-set stamp, and the stamp has a default', () => {
    expect(names(shape)).toEqual(names(table).filter((name) => name !== stamp));
    const stamped = Object.values(getTableColumns(table)).find((column) => column.name === stamp)!;
    expect(stamped.hasDefault).toBe(true);
  });

  it('is exactly the columns the manifest grants the provisioner INSERT on', () => {
    const grants = manifest(17, 'portal')
      .find((object) => object.identity === identity)!
      .grants.filter(
        (grant) => grant.grantee === 'provisionerRole' && grant.privileges.includes('INSERT')
      );
    expect(grants).toHaveLength(1);
    expect([...grants[0]!.columns!].sort()).toEqual(names(shape));
  });
});

describe('the statements the provisioner writes', () => {
  const db = drizzle.mock();

  it('never name a stamp, not even to write its DEFAULT', () => {
    const statements = [
      db.insert(demoStateEventInsert).values({ demoId: 'a', sequence: 1, toState: 'VERIFIED' }),
      db.insert(hostnameRegisterInsert).values({ label: 'a', demoId: 'b' }),
      db.insert(hostnameRetirementInsert).values({ label: 'a' }),
    ].map((statement) => statement.toSQL().sql);
    for (const text of statements) {
      expect(text).not.toMatch(/recorded_at|allocated_at|retired_at/);
    }
  });

  it('would name it if the full schema table were used, which is why the shapes exist', () => {
    const text = db.insert(hostnameRegister).values({ label: 'a', demoId: 'b' }).toSQL().sql;
    expect(text).toMatch(/allocated_at/);
  });
});
