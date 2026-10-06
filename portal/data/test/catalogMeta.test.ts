import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACL_COLUMNS,
  ALL_SHDEPEND_DEPTYPES,
  INFORMATION_SCHEMA_PUBLIC,
  AUTHID_REFERENCES,
  SHARED_OID_CATALOGS,
  SUPPORTED_MAJORS,
} from '../provision/catalogSnapshot.js';
import { MECHANISMS } from '../provision/manifest.js';
import { readMigrations } from '../provision/migrations.js';
import { SNAPSHOTS } from './catalog/index.js';
import { EXTRAS } from './closedWorldFixtures.js';
import { admin, resetServer, run, serverMajor } from './provisionSetup.js';

// The closed list is closed against the server's own metadata, per version: a
// catalog, a column, a privilege or a deptype the list has not classified
// fails here, before it can reach a server.

const KINDS = ['F', 'L', 'S', 'T', 'd', 'f', 'l', 'n', 'r', 's', 't'];

describe('the mechanism list and its fixtures', () => {
  it('has one closed-world fixture per mechanism the command checks itself', () => {
    const checked = MECHANISMS.filter((m) => m.external !== true).map((m) => m.id);
    expect([...new Set(EXTRAS.map((t) => t.id))].sort()).toEqual(checked.sort());
  });

  it('is the design note list, M01 to M29, with M26 covered through M02', () => {
    expect(MECHANISMS.map((m) => m.id)).toEqual(
      Array.from({ length: 29 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`)
    );
    expect(MECHANISMS.filter((m) => m.external === true).map((m) => m.id)).toEqual(['M26']);
  });

  it('has a committed snapshot for exactly the supported versions', () => {
    expect(Object.keys(SNAPSHOTS).map(Number).sort()).toEqual([...SUPPORTED_MAJORS].sort());
  });
});

describe('the catalog against the committed snapshot', () => {
  if (process.env['PORTAL_TEST_DATABASE_URL'] === undefined) {
    it('needs PORTAL_TEST_DATABASE_URL', () => {
      throw new Error('PORTAL_TEST_DATABASE_URL must name a PostgreSQL superuser connection');
    });
    return;
  }
  let major = 0;

  beforeAll(async () => {
    major = await serverMajor();
  });

  async function rows(sql: string): Promise<string[]> {
    const [result] = await admin('postgres', sql);
    return (result!.rows as { v: string }[]).map((r) => r.v);
  }

  it('every pg_catalog column and every privilege name is one the list was classified against', async () => {
    const columns = await rows(
      `SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, NULL) AS v
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`
    );
    const privileges: Record<string, string[]> = {};
    for (const kind of [...KINDS, ...(major >= 15 ? ['p'] : [])]) {
      privileges[kind] = await rows(
        `SELECT privilege_type AS v FROM aclexplode(acldefault('${kind}', 10))
          WHERE grantee = 10 ORDER BY 1`
      );
    }
    const snapshot = SNAPSHOTS[major];
    const generated =
      `export const COLUMNS: readonly string[] = ${JSON.stringify(columns, null, 2)};\n` +
      `export const PRIVILEGES: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(privileges, null, 2)};\n`;
    if (snapshot === undefined) {
      console.log(`CATALOG SNAPSHOT pg${major}.ts BEGIN\n${generated}CATALOG SNAPSHOT END`);
    }
    expect(snapshot, `no committed snapshot for PostgreSQL ${major}`).toBeDefined();
    expect([...columns].sort()).toEqual([...snapshot!.COLUMNS].sort());
    expect(privileges).toEqual(snapshot!.PRIVILEGES);
  });

  it('every catalog column referencing pg_authid is classified to a mechanism', async () => {
    const found = await rows(
      `SELECT fktable::text || '.' || array_to_string(fkcols, ',') AS v
         FROM pg_get_catalog_foreign_keys() WHERE pktable = 'pg_authid'::regclass ORDER BY 1`
    );
    expect(found).toEqual(Object.keys(AUTHID_REFERENCES[major] ?? {}).sort());
  });

  it('lists exactly the information_schema relations initdb grants to PUBLIC, SELECT alone', async () => {
    // template1 is the server's untouched initdb state: no test changes it.
    const [result] = await admin(
      'template1',
      `SELECT c.relname || ' ' || string_agg(x.privilege_type, ',' ORDER BY x.privilege_type) AS v
         FROM pg_class c, aclexplode(c.relacl) x
        WHERE c.relnamespace = 'information_schema'::regnamespace AND x.grantee = 0
        GROUP BY c.relname ORDER BY 1`
    );
    const found = (result!.rows as { v: string }[]).map((r) => r.v);
    const listed = INFORMATION_SCHEMA_PUBLIC[major];
    if (listed === undefined || listed.length === 0) {
      console.log(
        `INFORMATION SCHEMA pg${major} BEGIN\n${JSON.stringify(
          found.map((v) => v.replace(/ SELECT$/, '')),
          null,
          2
        )}\nINFORMATION SCHEMA END`
      );
    }
    expect(found).toEqual([...(listed ?? [])].sort().map((name) => `${name} SELECT`));
    const [none] = await admin(
      'template1',
      `SELECT count(*)::int AS n FROM pg_init_privs i JOIN pg_class c ON c.oid = i.objoid
        WHERE i.classoid = 'pg_class'::regclass AND c.relnamespace = 'information_schema'::regnamespace`
    );
    expect(none!.rows[0].n).toBe(0);
  });

  it('every aclitem[] column is classified to a mechanism', async () => {
    const found = await rows(
      `SELECT c.relname || '.' || a.attname AS v FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE a.atttypid = 'aclitem[]'::regtype AND c.relnamespace = 'pg_catalog'::regnamespace
          AND c.relkind = 'r' ORDER BY 1`
    );
    expect(found).toEqual(Object.keys(ACL_COLUMNS[major] ?? {}).sort());
  });

  it('every shared catalog with an oid is judged by a role-scoped rule (M25 scans the rest)', async () => {
    const found = await rows(
      `SELECT c.relname AS v FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'oid'
        WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relkind = 'r' AND c.relisshared
        ORDER BY 1`
    );
    expect(found).toEqual(Object.keys(SHARED_OID_CATALOGS[major] ?? {}).sort());
  });

  it('every classification names a mechanism on the list', () => {
    const ids = new Set(MECHANISMS.map((m) => m.id));
    for (const map of [AUTHID_REFERENCES, ACL_COLUMNS, SHARED_OID_CATALOGS]) {
      for (const byVersion of Object.values(map)) {
        for (const id of Object.values(byVersion)) expect(ids.has(id), id).toBe(true);
      }
    }
  });
});

describe('the manifest keeps step with the migrations', () => {
  if (process.env['PORTAL_TEST_DATABASE_URL'] === undefined) return;

  beforeAll(async () => {
    await resetServer();
  }, 60000);

  afterAll(async () => {
    await resetServer();
  }, 60000);

  it.each(readMigrations().map((m, i) => [m.tag, i] as const))(
    'after %s every object is classified and every entry due exists',
    async (_tag, index) => {
      await resetServer();
      // The post-check inside the run requires zero differences: nothing
      // unclassified, nothing from a later migration, every entry due present.
      const result = await run({ migrations: readMigrations().slice(0, index + 1) });
      expect(result.err).toEqual([]);
      expect(result.code).toBe(0);
    },
    60000
  );

  it('sees no pg_shdepend deptype the list does not know', async () => {
    expect((await run()).code).toBe(0);
    const [result] = await admin('postgres', 'SELECT DISTINCT deptype::text AS d FROM pg_shdepend');
    for (const row of result!.rows as { d: string }[]) {
      expect(ALL_SHDEPEND_DEPTYPES).toContain(row.d);
    }
  });
});
