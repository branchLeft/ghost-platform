import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDatabaseError } from '../src/databaseError.js';
import { bind, type Tx } from '../src/db.js';
import { InvalidDemoRequestError, type DemoRequestInput } from '../src/demoRequest.js';
import { ProspectDb } from '../src/prospect/index.js';
import { ProvisionerDb } from '../src/provisioner/index.js';
import { demoRequest } from '../src/schema.js';
import { createFixture, rejection, type Fixture } from './helpers.js';

// A prospect reads the request recorded for the address the transaction bound
// and no other. The policy, not the query, does the choosing.

let fx: Fixture;
let prospect: ProspectDb;

beforeAll(async () => {
  fx = await createFixture();
  prospect = new ProspectDb(fx.prospect);
}, 60000);

afterAll(async () => {
  await fx.close();
});

const ADDRESS_A = 'prospect-a@example.invalid';
const ADDRESS_B = 'prospect-b@example.invalid';
const PERMISSION_DENIED = '42501';

function request(verifiedAddress: string, publicationName: string): DemoRequestInput {
  return {
    verifiedSubject: `subject-of-${verifiedAddress}`,
    verifiedAddress,
    publicationName,
    newToGhost: true,
    outletType: 'outlet-type',
    consentWording: 'CONSENT_CONTACT_WORDING',
    explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
  };
}

async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    return readDatabaseError(error)?.code ?? `no SQLSTATE: ${String(error)}`;
  }
}

/** How many requests the front door role sees, with `address` bound or with nothing bound when null. */
async function seen(address: string | null): Promise<string[]> {
  return prospect.run(async (tx: Tx) => {
    if (address !== null) await bind(tx, 'portal.prospect_address', address);
    const rows = await tx.select({ name: demoRequest.publicationName }).from(demoRequest);
    return rows.map((row) => row.name).sort();
  });
}

describe('a prospect reads their own request and no other', () => {
  let idA = '';
  let idB = '';

  beforeAll(async () => {
    idA = (await prospect.submit(request(ADDRESS_A, 'NAME_OF_A'))).demoId;
    idB = (await prospect.submit(request(ADDRESS_B, 'NAME_OF_B'))).demoId;
  });

  it("reads the bound address's request (the positive control)", async () => {
    const own = await prospect.ownRequest(ADDRESS_A);
    expect(own).toMatchObject({ demoId: idA, publicationName: 'NAME_OF_A' });
    expect(own!.submittedAt).toBeInstanceOf(Date);
    expect(await prospect.ownRequest(ADDRESS_B)).toMatchObject({
      demoId: idB,
      publicationName: 'NAME_OF_B',
    });
  });

  it('returns only the three fields a status page needs', async () => {
    expect(Object.keys((await prospect.ownRequest(ADDRESS_A))!).sort()).toEqual([
      'demoId',
      'publicationName',
      'submittedAt',
    ]);
  });

  it('finds nothing for an address with no request', async () => {
    expect(await prospect.ownRequest('nobody@example.invalid')).toBeUndefined();
  });

  it('sees one row and never the other address, even for a statement with no filter at all', async () => {
    expect(await seen(ADDRESS_A)).toEqual(['NAME_OF_A']);
    expect(await seen(ADDRESS_B)).toEqual(['NAME_OF_B']);
  });

  it('sees nothing when no address is bound, and nothing for an empty or unknown one', async () => {
    expect(await seen(null)).toEqual([]);
    expect(await seen('')).toEqual([]);
    expect(await seen('nobody@example.invalid')).toEqual([]);
  });

  it('matches the address exactly: a different case, a wildcard or a prefix reads nothing', async () => {
    for (const other of [
      ADDRESS_A.toUpperCase(),
      '%',
      'prospect-a@example.invalid ',
      'prospect-a',
    ]) {
      expect(await seen(other)).toEqual([]);
    }
  });

  it('rebinding inside the transaction moves to the other single row, never to both', async () => {
    const names = await prospect.run(async (tx) => {
      await bind(tx, 'portal.prospect_address', ADDRESS_A);
      const first = await tx.select({ name: demoRequest.publicationName }).from(demoRequest);
      await bind(tx, 'portal.prospect_address', ADDRESS_B);
      const second = await tx.select({ name: demoRequest.publicationName }).from(demoRequest);
      return [first.map((r) => r.name), second.map((r) => r.name)];
    });
    expect(names).toEqual([['NAME_OF_A'], ['NAME_OF_B']]);
  });

  it('refuses an address the table could not hold, naming the field', async () => {
    const error = await rejection(prospect.ownRequest('Not-Lower@example.invalid'));
    expect(error).toBeInstanceOf(InvalidDemoRequestError);
    expect((error as InvalidDemoRequestError).field).toBe('verifiedAddress');
  });

  it('does not bind the address past the transaction: the next call on the pool sees nothing', async () => {
    await prospect.ownRequest(ADDRESS_A);
    expect(await seen(null)).toEqual([]);
  });

  it('shows the lifecycle worker every request, as before', async () => {
    const worker = new ProvisionerDb(fx.provisioner);
    expect((await worker.request(idA))?.verifiedAddress).toBe(ADDRESS_A);
    expect((await worker.request(idB))?.verifiedAddress).toBe(ADDRESS_B);
  });
});

describe('what the front door still cannot do', () => {
  it('cannot read back an insert it did not bind the address for: SQLSTATE 42501', async () => {
    const insert = (tx: Tx): Promise<unknown> =>
      tx
        .insert(demoRequest)
        .values({
          demoId: randomUUID(),
          verifiedSubject: 'returning',
          verifiedAddress: 'returning@example.invalid',
          publicationName: 'PUBLICATION_NAME',
          newToGhost: false,
          outletType: 'outlet-type',
          consentWording: 'W',
          explainerWording: 'E',
        })
        .returning();
    expect(await outcome(() => prospect.run(insert))).toBe(PERMISSION_DENIED);
  });

  it('cannot update or delete a request, even its own', async () => {
    const attempt = (work: (tx: Tx) => Promise<unknown>) => async (): Promise<unknown> =>
      prospect.run(async (tx) => {
        await bind(tx, 'portal.prospect_address', ADDRESS_A);
        return work(tx);
      });
    expect(
      await outcome(
        attempt((tx) =>
          tx
            .update(demoRequest)
            .set({ publicationName: 'CHANGED' })
            .where(sql`true`)
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(await outcome(attempt((tx) => tx.delete(demoRequest).where(sql`true`)))).toBe(
      PERMISSION_DENIED
    );
  });
});

describe('the policy is what does it', () => {
  // Each sabotage runs on one connection inside a transaction that is rolled
  // back, so the fixture is never left changed.
  async function inRolledBack<T>(
    steps: readonly string[],
    read: (query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>
  ): Promise<T> {
    const client = await fx.admin.connect();
    try {
      await client.query('BEGIN');
      for (const step of steps) await client.query(step);
      await client.query('SET LOCAL ROLE portal_prospect');
      await client.query("SELECT set_config('portal.prospect_address', $1, true)", [ADDRESS_A]);
      return await read((text) => client.query(text));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  const COUNT = 'SELECT count(*)::int AS n FROM portal.demo_request';

  it('shows exactly one row as it is shipped', async () => {
    const count = await inRolledBack([], async (query) => (await query(COUNT)).rows[0]!['n']);
    expect(count).toBe(1);
  });

  it('shows every address with the policy rewritten to read another address (rolled back)', async () => {
    const count = await inRolledBack(
      ['ALTER POLICY own_request ON portal.demo_request USING (true)'],
      async (query) => (await query(COUNT)).rows[0]!['n']
    );
    expect(count).toBeGreaterThan(1);
  });

  it('shows every address with a second permissive policy added (rolled back)', async () => {
    const count = await inRolledBack(
      ['CREATE POLICY open_all ON portal.demo_request FOR SELECT TO portal_prospect USING (true)'],
      async (query) => (await query(COUNT)).rows[0]!['n']
    );
    expect(count).toBeGreaterThan(1);
  });

  it('shows every address with row security off (rolled back)', async () => {
    const count = await inRolledBack(
      ['ALTER TABLE portal.demo_request DISABLE ROW LEVEL SECURITY'],
      async (query) => (await query(COUNT)).rows[0]!['n']
    );
    expect(count).toBeGreaterThan(1);
  });

  it('is shipped as one row after every sabotage was rolled back', async () => {
    const count = await inRolledBack([], async (query) => (await query(COUNT)).rows[0]!['n']);
    expect(count).toBe(1);
  });
});

describe('the grants and the policies, as the catalog holds them', () => {
  it('gives the front door INSERT and SELECT on the requests and nothing more', async () => {
    const result = await fx.admin.query<{ privilege: string }>(
      `SELECT p AS privilege FROM unnest($1::text[]) p
        WHERE has_table_privilege('portal_prospect', 'portal.demo_request', p) ORDER BY 1`,
      [['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']]
    );
    expect(result.rows.map((r) => r.privilege)).toEqual(['INSERT', 'SELECT']);
  });

  it('holds exactly three policies, each for a named role and none for PUBLIC', async () => {
    const result = await fx.admin.query<{ polname: string; roles: string; cmd: string }>(
      `SELECT polname, polcmd::text AS cmd,
              array_to_string(ARRAY(SELECT pg_get_userbyid(r) FROM unnest(polroles) r), ',') AS roles
         FROM pg_policy WHERE polrelid = 'portal.demo_request'::regclass ORDER BY polname`
    );
    expect(result.rows).toEqual([
      { polname: 'own_request', cmd: 'r', roles: 'portal_prospect' },
      { polname: 'provisioner_read', cmd: 'r', roles: 'portal_provisioner' },
      { polname: 'request_insert', cmd: 'a', roles: 'portal_prospect' },
    ]);
  });

  it('lets the front door call the bound function and nobody else but its owner', async () => {
    const result = await fx.admin.query<{ role: string; held: boolean }>(
      `SELECT r AS role, has_function_privilege(r, 'public.bound_address()', 'EXECUTE') AS held
         FROM unnest($1::text[]) r ORDER BY 1`,
      [['portal_owner', 'portal_prospect', 'portal_provisioner', 'portal_tenant']]
    );
    expect(result.rows).toEqual([
      { role: 'portal_owner', held: false },
      { role: 'portal_prospect', held: true },
      { role: 'portal_provisioner', held: false },
      { role: 'portal_tenant', held: false },
    ]);
  });
});
