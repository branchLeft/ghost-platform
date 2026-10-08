import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidPublicationError, OwnerDb } from '../src/owner/index.js';
import {
  NotCurrentVersionError,
  TenantDb,
  TermsNotAcceptedError,
  bindTenant,
} from '../src/tenant/index.js';
import { connect, enterRole } from '../src/db.js';
import { assertTenantTablesIsolated } from '../src/isolation.js';
import * as schema from '../src/schema.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

const DAY = 86_400_000;
// The database stamps a version's publication time from its own clock, so the
// timeline is built from the real time now; reads pass a clock of their own.
const BASE = Date.now();
const day = (n: number): Date => new Date(BASE + n * DAY);

// The list names the three recorded suppliers; every prose field is a placeholder.
const LIST_V1 = [
  { name: 'HETZNER', purpose: 'PURPOSE_PLACEHOLDER' },
  { name: 'OVHCLOUD', purpose: 'PURPOSE_PLACEHOLDER' },
  { name: 'STRIPE', purpose: 'PURPOSE_PLACEHOLDER' },
];

const T_EFFECTIVE = day(-40);
const T_LIST = day(31);
const NOW = day(32);

let fixture: Fixture;
let owner: OwnerDb;
let tenant: TenantDb;
const scopeA = bindTenant(TENANT_A);
const scopeB = bindTenant(TENANT_B);

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  tenant = new TenantDb(fixture.tenant);
  await owner.publishDocument({
    kind: 'terms',
    title: 'TERMS_TITLE',
    body: 'TERMS_BODY_V1',
    effectiveAt: T_EFFECTIVE,
  });
  await owner.publishDocument({
    kind: 'usage',
    title: 'USAGE_TITLE',
    body: 'USAGE_BODY_V1',
    effectiveAt: T_EFFECTIVE,
  });
  await owner.publishDocument({
    kind: 'subprocessors',
    title: 'SUBPROCESSORS_TITLE',
    body: 'SUBPROCESSORS_BODY',
    entries: LIST_V1,
    effectiveAt: T_LIST,
  });
});

afterAll(async () => {
  await fixture.close();
});

describe('the versioned document set', () => {
  it('is covered by the isolation check', () => {
    expect(() => assertTenantTablesIsolated(schema)).not.toThrow();
  });

  it('serves each kind at its current version with its effective date', async () => {
    const docs = await tenant.currentDocuments(scopeA, NOW);
    expect(docs.map((d) => [d.kind, d.version])).toEqual([
      ['terms', 1],
      ['usage', 1],
      ['subprocessors', 1],
    ]);
    expect(docs[0]).toMatchObject({ title: 'TERMS_TITLE', effectiveAt: T_EFFECTIVE });
    expect(docs[2]?.entries).toEqual(LIST_V1);
    expect(docs[2]?.noticeDays).toBe(30);
  });

  it('serves nothing before the first version is effective', async () => {
    expect(await tenant.currentDocuments(scopeA, day(-50))).toEqual([]);
  });

  it('numbers versions one after another per kind', async () => {
    const view = await owner.publishDocument({
      kind: 'usage',
      title: 'USAGE_TITLE',
      body: 'USAGE_BODY_V2',
      effectiveAt: day(400),
    });
    expect(view.version).toBe(2);
    // v2 is far in the future and is read again by later tests only at later times.
    expect((await tenant.currentDocument(scopeA, 'usage', NOW))?.version).toBe(1);
  });
});

describe('the notice period on a sub-processor entry', () => {
  const NEW_ENTRY = { name: 'NEW_SUBPROCESSOR_PLACEHOLDER', purpose: 'PURPOSE_PLACEHOLDER' };
  const LIST_V2 = [...LIST_V1, NEW_ENTRY];
  const LIST = { kind: 'subprocessors', title: 'T', body: 'B' } as const;

  it('keeps a new entry out of the live list until its notice has elapsed', async () => {
    const published = await owner.publishDocument({
      ...LIST,
      title: 'SUBPROCESSORS_TITLE',
      body: 'SUBPROCESSORS_BODY',
      entries: LIST_V2,
      effectiveAt: day(62),
    });
    expect(published.version).toBe(2);

    // Published and stored, but not live: the tenant still sees the old list.
    for (const offset of [32, 40, 61]) {
      const live = await tenant.currentDocument(scopeA, 'subprocessors', day(offset));
      expect(live?.version).toBe(1);
      expect(live?.entries.map((e) => e.name)).not.toContain(NEW_ENTRY.name);
    }
    const justBefore = new Date(day(62).getTime() - 1);
    expect((await tenant.currentDocument(scopeA, 'subprocessors', justBefore))?.version).toBe(1);
    const live = await tenant.currentDocument(scopeA, 'subprocessors', day(62));
    expect(live?.version).toBe(2);
    expect(live?.entries.map((e) => e.name)).toContain(NEW_ENTRY.name);
  });

  it('announces the coming version as upcoming, apart from the live list, until it is live', async () => {
    const upcoming = await tenant.upcomingSubprocessors(scopeA, day(40));
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.document).toMatchObject({ version: 2, effectiveAt: day(62) });
    expect(upcoming[0]?.added).toEqual([NEW_ENTRY]);
    expect(upcoming[0]?.removed).toEqual([]);
    // Announcing is not going live: it is in no current list and cannot be accepted.
    const current = await tenant.currentDocuments(scopeA, day(40));
    expect(current.find((d) => d.kind === 'subprocessors')?.version).toBe(1);
    expect(await tenant.upcomingSubprocessors(scopeB, day(40))).toHaveLength(1);
    // Before it was published there was nothing to announce; once live, nothing is upcoming.
    expect(await tenant.upcomingSubprocessors(scopeA, day(-5))).toEqual([]);
    expect(await tenant.upcomingSubprocessors(scopeA, day(62))).toEqual([]);
  });

  it('names an entry dropped from the list as well as one added', async () => {
    await owner.publishDocument({
      ...LIST,
      entries: [{ name: 'HETZNER', purpose: 'PURPOSE_PLACEHOLDER' }, NEW_ENTRY],
      effectiveAt: day(95),
    });
    const upcoming = await tenant.upcomingSubprocessors(scopeA, day(70));
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.added).toEqual([]);
    expect(upcoming[0]?.removed.map((e) => e.name)).toEqual(['OVHCLOUD', 'STRIPE']);
  });

  it('refuses a publication effective inside its notice, and the table refuses it too', async () => {
    await expect(
      owner.publishDocument({ ...LIST, entries: LIST_V1, noticeDays: 30, effectiveAt: day(29) })
    ).rejects.toBeInstanceOf(InvalidPublicationError);
    await expect(
      fixture.adminDb.insert(schema.documentVersion).values({
        ...LIST,
        version: 9,
        entries: LIST_V1,
        effectiveAt: day(29),
        noticeDays: 30,
      })
    ).rejects.toThrow();
  });

  it('takes the publication time from the database, never from the caller', async () => {
    // A caller that reports a publication 30 days ago, to take effect at once.
    const backdated = {
      ...LIST,
      entries: LIST_V2,
      noticeDays: 30,
      effectiveAt: new Date(Date.now() + DAY),
      publishedAt: new Date(Date.now() - 30 * DAY),
    };
    await expect(owner.publishDocument(backdated as never)).rejects.toBeInstanceOf(
      InvalidPublicationError
    );
    const rows = await fixture.adminDb.select().from(schema.documentVersion);
    expect(rows.every((row) => row.publishedAt.getTime() >= BASE - 1000)).toBe(true);
  });

  it('refuses a sub-processor version with no notice, no entries, or entries on other kinds', async () => {
    const base = { title: 'T', body: 'B', effectiveAt: NOW };
    await expect(
      owner.publishDocument({ ...base, kind: 'subprocessors', entries: LIST_V1, noticeDays: 0 })
    ).rejects.toBeInstanceOf(InvalidPublicationError);
    await expect(owner.publishDocument({ ...base, kind: 'subprocessors' })).rejects.toBeInstanceOf(
      InvalidPublicationError
    );
    await expect(
      owner.publishDocument({ ...base, kind: 'terms', entries: LIST_V1 })
    ).rejects.toBeInstanceOf(InvalidPublicationError);
    // The ruled notice is the floor: a shorter one is refused here and by the table.
    await expect(
      owner.publishDocument({ ...base, kind: 'subprocessors', entries: LIST_V1, noticeDays: 29 })
    ).rejects.toBeInstanceOf(InvalidPublicationError);
    await expect(
      fixture.adminDb.insert(schema.documentVersion).values({
        ...LIST,
        version: 9,
        entries: LIST_V1,
        effectiveAt: day(400),
        noticeDays: 29,
      })
    ).rejects.toThrow();
    await expect(
      fixture.adminDb.insert(schema.documentVersion).values({
        ...LIST,
        version: 9,
        entries: LIST_V1,
        effectiveAt: NOW,
        noticeDays: 0,
      })
    ).rejects.toThrow();
  });
});

describe('published versions are immutable', () => {
  it('refuses the tenant and the owner changing or removing a version', async () => {
    await expect(
      tenant.run(scopeA, (tx) => tx.update(schema.documentVersion).set({ body: 'ALTERED' }))
    ).rejects.toThrow();
    await expect(tenant.run(scopeA, (tx) => tx.delete(schema.documentVersion))).rejects.toThrow();
    await expect(
      tenant.run(scopeA, (tx) =>
        tx.insert(schema.documentVersion).values({
          kind: 'terms',
          version: 7,
          title: 'T',
          body: 'B',
          effectiveAt: NOW,
        })
      )
    ).rejects.toThrow();
    await expect(
      owner.run((tx) => tx.update(schema.documentVersion).set({ body: 'ALTERED' }))
    ).rejects.toThrow();
    await expect(owner.run((tx) => tx.delete(schema.documentVersion))).rejects.toThrow();
    expect((await tenant.currentDocument(scopeA, 'terms', NOW))?.body).toBe('TERMS_BODY_V1');
  });
});

describe('per-tenant acceptance', () => {
  it('starts with both acceptable documents pending, and the gate closed', async () => {
    const pending = await tenant.pendingAcceptances(scopeA, NOW);
    expect(pending.map((d) => d.kind)).toEqual(['terms', 'usage']);
    await expect(tenant.assertAccepted(scopeA, NOW)).rejects.toBeInstanceOf(TermsNotAcceptedError);
  });

  it('records who accepted which version and when, for that tenant only', async () => {
    const when = new Date(NOW.getTime() + 30 * 60_000);
    await tenant.acceptDocument(
      scopeA,
      { kind: 'terms', version: 1, acceptedBy: 'SESSION_SUBJECT_A' },
      when
    );
    expect(await tenant.acceptances(scopeA)).toEqual([
      {
        kind: 'terms',
        version: 1,
        acceptedBy: 'SESSION_SUBJECT_A',
        acceptedAt: when,
        title: 'TERMS_TITLE',
        effectiveAt: T_EFFECTIVE,
      },
    ]);
    expect(await tenant.acceptances(scopeB)).toEqual([]);
    expect((await tenant.pendingAcceptances(scopeA, NOW)).map((d) => d.kind)).toEqual(['usage']);
    expect((await tenant.pendingAcceptances(scopeB, NOW)).map((d) => d.kind)).toEqual([
      'terms',
      'usage',
    ]);
    const raw = await tenant.run(scopeB, (tx) => tx.select().from(schema.documentAcceptance));
    expect(raw).toEqual([]);
  });

  it('opens the gate once every current document is accepted, and records a repeat once', async () => {
    const first = new Date(NOW.getTime() + 31 * 60_000);
    await tenant.acceptDocument(
      scopeA,
      { kind: 'usage', version: 1, acceptedBy: 'SESSION_SUBJECT_A' },
      first
    );
    await tenant.acceptDocument(
      scopeA,
      { kind: 'usage', version: 1, acceptedBy: 'SESSION_SUBJECT_OTHER' },
      new Date(NOW.getTime() + 60 * 60_000)
    );
    await expect(tenant.assertAccepted(scopeA, NOW)).resolves.toBeUndefined();
    const usage = (await tenant.acceptances(scopeA)).filter((a) => a.kind === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ acceptedBy: 'SESSION_SUBJECT_A', acceptedAt: first });
    await expect(tenant.assertAccepted(scopeB, NOW)).rejects.toBeInstanceOf(TermsNotAcceptedError);
  });

  it('refuses acceptance of a version that is not in force, or of a kind that is not accepted', async () => {
    // usage v2 exists but is not effective until 2027; terms v9 does not exist.
    await expect(
      tenant.acceptDocument(scopeB, { kind: 'usage', version: 2, acceptedBy: 'S' }, NOW)
    ).rejects.toBeInstanceOf(NotCurrentVersionError);
    await expect(
      tenant.acceptDocument(scopeB, { kind: 'terms', version: 9, acceptedBy: 'S' }, NOW)
    ).rejects.toBeInstanceOf(NotCurrentVersionError);
    await expect(
      tenant.acceptDocument(scopeB, { kind: 'subprocessors', version: 1, acceptedBy: 'S' }, NOW)
    ).rejects.toBeInstanceOf(NotCurrentVersionError);
    expect(await tenant.acceptances(scopeB)).toEqual([]);
  });

  it("refuses a tenant writing, changing or removing another tenant's acceptance", async () => {
    await expect(
      tenant.run(scopeA, (tx) =>
        tx.insert(schema.documentAcceptance).values({
          tenantId: TENANT_B,
          kind: 'terms',
          version: 1,
          acceptedBy: 'S',
          acceptedAt: NOW,
        })
      )
    ).rejects.toThrow();
    await expect(
      tenant.run(scopeA, (tx) => tx.update(schema.documentAcceptance).set({ acceptedBy: 'X' }))
    ).rejects.toThrow();
    await expect(
      tenant.run(scopeA, (tx) => tx.delete(schema.documentAcceptance))
    ).rejects.toThrow();
    await expect(
      owner.run((tx) =>
        tx.insert(schema.documentAcceptance).values({
          tenantId: TENANT_B,
          kind: 'terms',
          version: 1,
          acceptedBy: 'S',
          acceptedAt: NOW,
        })
      )
    ).rejects.toThrow();
  });

  it('refuses an acceptance read with no tenant bound', async () => {
    let message = 'did not fail';
    try {
      await connect(fixture.tenant).transaction(async (tx) => {
        await enterRole(tx, 'portal_tenant');
        return tx.select().from(schema.documentAcceptance);
      });
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause;
      message = cause?.message ?? (error as Error).message;
    }
    expect(message).toMatch(/no tenant bound to the session/);
  });
});

describe('re-acceptance on a new version', () => {
  const TERMS_V2_EFFECTIVE = day(40);
  const LATER = day(42);

  it('asks again once a new version is in force, and leaves what was accepted as it was', async () => {
    await owner.publishDocument({
      kind: 'terms',
      title: 'TERMS_TITLE_V2',
      body: 'TERMS_BODY_V2',
      effectiveAt: TERMS_V2_EFFECTIVE,
    });
    const before = await tenant.acceptances(scopeA);

    // Published, not yet in force: A is still square, and cannot accept it early.
    await expect(tenant.assertAccepted(scopeA, NOW)).resolves.toBeUndefined();
    await expect(
      tenant.acceptDocument(scopeA, { kind: 'terms', version: 2, acceptedBy: 'S' }, NOW)
    ).rejects.toBeInstanceOf(NotCurrentVersionError);

    // In force: the gate closes again for A, naming terms v2 only.
    const error = await tenant.assertAccepted(scopeA, LATER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TermsNotAcceptedError);
    expect((error as TermsNotAcceptedError).pending.map((d) => [d.kind, d.version])).toEqual([
      ['terms', 2],
    ]);
    // The old acceptance is exactly what it was, and the old version is still v1's text.
    expect(await tenant.acceptances(scopeA)).toEqual(before);

    // The superseded version can no longer be accepted.
    await expect(
      tenant.acceptDocument(scopeB, { kind: 'terms', version: 1, acceptedBy: 'S' }, LATER)
    ).rejects.toBeInstanceOf(NotCurrentVersionError);

    await tenant.acceptDocument(
      scopeA,
      { kind: 'terms', version: 2, acceptedBy: 'SESSION_SUBJECT_A' },
      LATER
    );
    await expect(tenant.assertAccepted(scopeA, LATER)).resolves.toBeUndefined();
    const after = await tenant.acceptances(scopeA);
    expect(after.map((a) => [a.kind, a.version])).toEqual([
      ['terms', 2],
      ['usage', 1],
      ['terms', 1],
    ]);
    expect(after.find((a) => a.kind === 'terms' && a.version === 1)).toEqual(
      before.find((a) => a.kind === 'terms' && a.version === 1)
    );
    expect(after.find((a) => a.version === 1 && a.kind === 'terms')?.title).toBe('TERMS_TITLE');
  });
});
