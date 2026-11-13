import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDatabaseError } from '../src/databaseError.js';
import { connect, enterRole, type Tx } from '../src/db.js';
import { OwnerDb } from '../src/owner/index.js';
import { ProspectDb } from '../src/prospect/index.js';
import { ProvisionerDb } from '../src/provisioner/index.js';
import {
  DemoRequestExistsError,
  DemoRequestIdTakenError,
  InvalidDemoRequestError,
  type DemoRequestInput,
} from '../src/demoRequest.js';
import {
  demoRequest,
  demoStateEvent,
  hostnameRegister,
  hostnameRetirement,
  tenantRegister,
} from '../src/schema.js';
import { TenantDb, bindTenant } from '../src/tenant/index.js';
import { TENANT_A, createFixture, rejection, type Fixture } from './helpers.js';

let fx: Fixture;
let prospect: ProspectDb;

const PERMISSION_DENIED = '42501';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

beforeAll(async () => {
  fx = await createFixture();
  prospect = new ProspectDb(fx.prospect);
}, 60000);

afterAll(async () => {
  await fx.close();
});

let counter = 0;
/** A valid request from a prospect no earlier test has used. */
function request(change: Partial<DemoRequestInput> = {}): DemoRequestInput {
  counter += 1;
  return {
    verifiedSubject: `subject-${counter}`,
    verifiedAddress: `person-${counter}@example.invalid`,
    publicationName: 'PUBLICATION_NAME',
    description: 'DESCRIPTION',
    accentColour: '#112233',
    theme: 'theme-one',
    font: 'font-one',
    newToGhost: true,
    importSource: 'IMPORT_SOURCE',
    outletType: 'outlet-type',
    logoHash: 'b'.repeat(64),
    consentWording: 'CONSENT_CONTACT_WORDING',
    explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
    ...change,
  };
}

/** The SQLSTATE the database refused the work with, or `ok` when it ran. */
async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    return readDatabaseError(error)?.code ?? `no SQLSTATE: ${String(error)}`;
  }
}

const asProspect =
  (work: (tx: Tx) => Promise<unknown>): (() => Promise<unknown>) =>
  () =>
    prospect.run(work);
const asProvisioner =
  (work: (tx: Tx) => Promise<unknown>): (() => Promise<unknown>) =>
  () =>
    new ProvisionerDb(fx.provisioner).run(work);
const asOwner =
  (work: (tx: Tx) => Promise<unknown>): (() => Promise<unknown>) =>
  () =>
    new OwnerDb(fx.owner).run(work);
const asTenant =
  (work: (tx: Tx) => Promise<unknown>): (() => Promise<unknown>) =>
  () =>
    new TenantDb(fx.tenant).run(bindTenant(TENANT_A), work);

/** A row the table takes, for the statements that go straight at it. */
function row(
  change: Partial<typeof demoRequest.$inferInsert> = {}
): typeof demoRequest.$inferInsert {
  counter += 1;
  return {
    demoId: randomUUID(),
    verifiedSubject: `direct-${counter}`,
    verifiedAddress: `direct-${counter}@example.invalid`,
    publicationName: 'PUBLICATION_NAME',
    newToGhost: false,
    outletType: 'outlet-type',
    consentWording: 'CONSENT_CONTACT_WORDING',
    explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
    ...change,
  };
}

describe('a request is recorded with its answers and a timestamp', () => {
  it('records every answer against the verified address and returns the demo id', async () => {
    const input = request();
    const before = Date.now();
    const { demoId } = await prospect.submit(input);
    const after = Date.now();
    expect(demoId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await new OwnerDb(fx.owner).demoRequest(demoId);
    expect(stored).toMatchObject({
      demoId,
      verifiedSubject: input.verifiedSubject,
      verifiedAddress: input.verifiedAddress,
      publicationName: 'PUBLICATION_NAME',
      description: 'DESCRIPTION',
      accentColour: '#112233',
      theme: 'theme-one',
      font: 'font-one',
      newToGhost: true,
      importSource: 'IMPORT_SOURCE',
      outletType: 'outlet-type',
      logoHash: 'b'.repeat(64),
      consentWording: 'CONSENT_CONTACT_WORDING',
      explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
    });
    // The time is the database's own clock, within the moments of the call
    // (allowing for a little skew between this process and the server).
    const at = stored!.submittedAt.getTime();
    expect(at).toBeGreaterThan(before - 2000);
    expect(at).toBeLessThan(after + 2000);
  });

  it('records a minimal request with its optional answers null', async () => {
    const { demoId } = await prospect.submit({
      verifiedSubject: 'minimal-subject',
      verifiedAddress: 'minimal@example.invalid',
      publicationName: 'PUBLICATION_NAME',
      newToGhost: false,
      outletType: 'outlet-type',
      consentWording: 'CONSENT_CONTACT_WORDING',
      explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
    });
    const stored = await new ProvisionerDb(fx.provisioner).request(demoId);
    expect(stored).toMatchObject({
      description: null,
      accentColour: null,
      theme: null,
      font: null,
      importSource: null,
      logoHash: null,
      newToGhost: false,
    });
  });

  it('lets the lifecycle worker and the owner console read it, and nobody else', async () => {
    const { demoId } = await prospect.submit(request());
    expect((await new ProvisionerDb(fx.provisioner).request(demoId))?.demoId).toBe(demoId);
    expect((await new OwnerDb(fx.owner).listRequests()).map((r) => r.demoId)).toContain(demoId);
    expect(await new OwnerDb(fx.owner).demoRequest(randomUUID())).toBeUndefined();
    expect(await new ProvisionerDb(fx.provisioner).request(randomUUID())).toBeUndefined();
    expect(await outcome(asTenant((tx) => tx.select().from(demoRequest)))).toBe(PERMISSION_DENIED);
  });

  it('refuses a malformed request before any statement, naming the field', async () => {
    const error = await rejection(prospect.submit(request({ verifiedAddress: 'NOT-LOWER@x.y' })));
    expect(error).toBeInstanceOf(InvalidDemoRequestError);
    expect((error as InvalidDemoRequestError).field).toBe('verifiedAddress');
  });
});

describe('one request per verified address, enforced by the table', () => {
  it('refuses a second submission for the same address with a typed error', async () => {
    const first = request();
    await prospect.submit(first);
    const error = await rejection(
      prospect.submit(request({ verifiedAddress: first.verifiedAddress }))
    );
    expect(error).toBeInstanceOf(DemoRequestExistsError);
  });

  it('refuses it at the table, whichever process sends it: SQLSTATE 23505 on the address constraint', async () => {
    const taken = row();
    await fx.adminDb.insert(demoRequest).values(taken);
    const error = await rejection(
      prospect.run((tx) =>
        tx.insert(demoRequest).values(row({ verifiedAddress: taken.verifiedAddress }))
      )
    );
    expect(readDatabaseError(error)).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'demo_request_verified_address_unique',
    });
  });

  it('lets exactly one of two simultaneous submissions for an address win', async () => {
    const address = `race-${counter}@example.invalid`;
    const results = await Promise.allSettled([
      prospect.submit(request({ verifiedAddress: address })),
      prospect.submit(request({ verifiedAddress: address })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(DemoRequestExistsError);
    const stored = await fx.adminDb
      .select()
      .from(demoRequest)
      .where(eq(demoRequest.verifiedAddress, address));
    expect(stored).toHaveLength(1);
  });

  it('refuses a demo id already taken, with its own typed error', async () => {
    const fixed = randomUUID();
    const reused = new ProspectDb(fx.prospect, () => fixed);
    await reused.submit(request());
    expect(await rejection(reused.submit(request()))).toBeInstanceOf(DemoRequestIdTakenError);
  });

  it('is the constraint that does it: with it dropped (and rolled back), the same insert is accepted', async () => {
    const taken = row();
    await fx.adminDb.insert(demoRequest).values(taken);
    const client = await fx.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE portal.demo_request DROP CONSTRAINT demo_request_verified_address_unique'
      );
      await client.query(
        `INSERT INTO portal.demo_request (demo_id, verified_subject, verified_address, publication_name,
           new_to_ghost, outlet_type, consent_wording, explainer_wording)
         VALUES ($1, 'sabotage', $2, 'PUBLICATION_NAME', false, 'outlet-type', 'W', 'E')`,
        [randomUUID(), taken.verifiedAddress]
      );
      const count = await client.query(
        'SELECT count(*)::int AS n FROM portal.demo_request WHERE verified_address = $1',
        [taken.verifiedAddress]
      );
      expect(count.rows[0].n).toBe(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const after = await fx.adminDb
      .select()
      .from(demoRequest)
      .where(eq(demoRequest.verifiedAddress, taken.verifiedAddress));
    expect(after).toHaveLength(1);
  });
});

describe('the front door role inserts a request and does nothing else', () => {
  it('inserts (the positive control)', async () => {
    expect(await outcome(asProspect((tx) => tx.insert(demoRequest).values(row())))).toBe('ok');
  });

  it('cannot read a request back: SQLSTATE 42501, not an empty result', async () => {
    expect(await outcome(asProspect((tx) => tx.select().from(demoRequest)))).toBe(
      PERMISSION_DENIED
    );
    expect(
      await outcome(asProspect((tx) => tx.insert(demoRequest).values(row()).returning()))
    ).toBe(PERMISSION_DENIED);
  });

  it('cannot update a request: SQLSTATE 42501', async () => {
    expect(
      await outcome(
        asProspect((tx) =>
          tx
            .update(demoRequest)
            .set({ publicationName: 'CHANGED' })
            .where(sql`true`)
        )
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('cannot delete a request: SQLSTATE 42501', async () => {
    expect(await outcome(asProspect((tx) => tx.delete(demoRequest).where(sql`true`)))).toBe(
      PERMISSION_DENIED
    );
  });

  it('cannot truncate the requests', async () => {
    expect(
      await outcome(asProspect((tx) => tx.execute(sql.raw('TRUNCATE portal.demo_request'))))
    ).toBe(PERMISSION_DENIED);
  });

  it('touches no other portal table: not the register, the events, the retirements or the tenants', async () => {
    for (const table of [hostnameRegister, hostnameRetirement, demoStateEvent, tenantRegister]) {
      expect(await outcome(asProspect((tx) => tx.select().from(table)))).toBe(PERMISSION_DENIED);
    }
    expect(
      await outcome(
        asProspect((tx) =>
          tx
            .insert(hostnameRegister)
            .values({ label: 'ssssssssssssssssssss', demoId: randomUUID() })
        )
      )
    ).toBe(PERMISSION_DENIED);
    expect(
      await outcome(
        asProspect((tx) =>
          tx
            .insert(demoStateEvent)
            .values({ demoId: randomUUID(), sequence: 1, toState: 'VERIFIED' })
        )
      )
    ).toBe(PERMISSION_DENIED);
  });

  it('is a permission, not a convention: grant the privilege (rolled back) and the same statement runs', async () => {
    const client = await fx.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('GRANT SELECT, UPDATE, DELETE ON portal.demo_request TO portal_prospect');
      await client.query('SET LOCAL ROLE portal_prospect');
      expect(
        (await client.query('SELECT count(*)::int AS n FROM portal.demo_request')).rows[0].n
      ).toBeGreaterThan(0);
      await client.query("UPDATE portal.demo_request SET publication_name = 'CHANGED'");
      await client.query('DELETE FROM portal.demo_request');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await outcome(asProspect((tx) => tx.select().from(demoRequest)))).toBe(
      PERMISSION_DENIED
    );
    expect((await fx.adminDb.select().from(demoRequest)).length).toBeGreaterThan(0);
  });

  it('is changed by no other role either', async () => {
    for (const run of [asProvisioner, asOwner]) {
      expect(
        await outcome(
          run((tx) =>
            tx
              .update(demoRequest)
              .set({ publicationName: 'CHANGED' })
              .where(sql`true`)
          )
        )
      ).toBe(PERMISSION_DENIED);
      expect(await outcome(run((tx) => tx.delete(demoRequest).where(sql`true`)))).toBe(
        PERMISSION_DENIED
      );
      expect(await outcome(run((tx) => tx.insert(demoRequest).values(row())))).toBe(
        PERMISSION_DENIED
      );
    }
  });
});

describe('the table refuses what the code would not write, even to a statement that skips the code', () => {
  it.each([
    ['an upper-case address', { verifiedAddress: 'Upper@example.invalid' }],
    ['an address with no dotted domain', { verifiedAddress: 'person@example' }],
    ['an address with a space', { verifiedAddress: 'per son@example.invalid' }],
    ['an empty publication name', { publicationName: '' }],
    ['a publication name over 100 characters', { publicationName: 'x'.repeat(101) }],
    ['a description over 500 characters', { description: 'x'.repeat(501) }],
    ['a colour that is not lower-case hex', { accentColour: '#ABCDEF' }],
    ['a theme that is not a slug', { theme: 'Not A Slug' }],
    ['an outlet type that is not a slug', { outletType: 'NOT A SLUG' }],
    ['a logo hash that is not 64 hex characters', { logoHash: 'abc' }],
    ['empty consent wording', { consentWording: '' }],
    ['an empty explainer wording', { explainerWording: '' }],
    ['an empty import source', { importSource: '' }],
    ['an empty subject', { verifiedSubject: '' }],
  ])('refuses %s: SQLSTATE 23514', async (_name, change) => {
    expect(await outcome(asProspect((tx) => tx.insert(demoRequest).values(row(change))))).toBe(
      CHECK_VIOLATION
    );
  });

  it('refuses a null in a required column', async () => {
    expect(
      await outcome(
        asProspect((tx) =>
          tx.insert(demoRequest).values(row({ publicationName: null as unknown as string }))
        )
      )
    ).toBe('23502');
  });

  it('takes the time from the database when none is given', async () => {
    const taken = row();
    await fx.adminDb.insert(demoRequest).values(taken);
    const [stored] = await fx.adminDb
      .select()
      .from(demoRequest)
      .where(eq(demoRequest.demoId, taken.demoId));
    expect(Math.abs(stored!.submittedAt.getTime() - Date.now())).toBeLessThan(5000);
  });
});

describe('the front door role and its login', () => {
  async function one(text: string): Promise<Record<string, unknown>> {
    return (await fx.admin.query(text)).rows[0] as Record<string, unknown>;
  }

  it('is NOLOGIN, cannot bypass row policies and is no superuser', async () => {
    expect(
      await one(
        `SELECT rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolinherit
           FROM pg_roles WHERE rolname = 'portal_prospect'`
      )
    ).toEqual({
      rolcanlogin: false,
      rolbypassrls: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
    });
  });

  it('has one login, a member of this role alone', async () => {
    const result = await fx.admin.query<{ member: string; role: string }>(
      `SELECT m.rolname AS member, r.rolname AS role
         FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles r ON r.oid = a.roleid
        WHERE m.rolname = 'portal_test_prospect_login'`
    );
    expect(result.rows).toEqual([
      { member: 'portal_test_prospect_login', role: 'portal_prospect' },
    ]);
  });

  it('cannot assume any other portal role', async () => {
    const db = connect(fx.prospect);
    for (const role of ['portal_owner', 'portal_tenant', 'portal_provisioner'] as const) {
      expect(await outcome(() => db.transaction((tx) => enterRole(tx, role)))).toBe(
        PERMISSION_DENIED
      );
    }
  });

  it('is not reachable from the tenant, owner or provisioner logins', async () => {
    for (const pool of [fx.tenant, fx.owner, fx.provisioner]) {
      expect(
        await outcome(() => connect(pool).transaction((tx) => enterRole(tx, 'portal_prospect')))
      ).toBe(PERMISSION_DENIED);
    }
  });

  it('holds nothing as the bare login: every statement goes through the role switch', async () => {
    expect(await outcome(() => connect(fx.prospect).select().from(demoRequest))).toBe(
      PERMISSION_DENIED
    );
    expect(await outcome(() => connect(fx.prospect).insert(demoRequest).values(row()))).toBe(
      PERMISSION_DENIED
    );
  });

  it('runs as portal_prospect even for a login that could do more', async () => {
    const who = await new ProspectDb(fx.dual).run(async (tx) => {
      const result = await tx.execute<{ who: string }>(sql`SELECT current_user AS who`);
      return result.rows[0]?.who;
    });
    expect(who).toBe('portal_prospect');
  });
});

describe('the privilege table, role by role, as the catalog holds it', () => {
  const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

  async function held(role: string): Promise<string[]> {
    const result = await fx.admin.query<{ privilege: string; held: boolean }>(
      `SELECT p AS privilege, has_table_privilege($1, 'portal.demo_request', p) AS held
         FROM unnest($2::text[]) p`,
      [role, PRIVILEGES]
    );
    return result.rows.filter((r) => r.held).map((r) => r.privilege);
  }

  it('gives the front door INSERT alone, the worker and the console SELECT, the tenant nothing', async () => {
    expect(await held('portal_prospect')).toEqual(['INSERT']);
    expect(await held('portal_provisioner')).toEqual(['SELECT']);
    expect(await held('portal_owner')).toEqual(['SELECT']);
    expect(await held('portal_tenant')).toEqual([]);
  });

  it('gives the front door no column privilege anywhere either', async () => {
    const result = await fx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM information_schema.column_privileges
        WHERE grantee = 'portal_prospect' AND table_schema = 'portal' AND privilege_type <> 'INSERT'`
    );
    expect(result.rows[0]!.n).toBe(0);
  });
});
