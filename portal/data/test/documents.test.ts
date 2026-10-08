import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidPublicationError, OwnerDb } from '../src/owner/index.js';
import {
  NotCurrentVersionError,
  TenantDb,
  TermsNotAcceptedError,
  bindTenant,
} from '../src/tenant/index.js';
import { assertTenantTablesIsolated } from '../src/isolation.js';
import * as schema from '../src/schema.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

const DAY = 86_400_000;
const at = (iso: string): Date => new Date(iso);

// The list names the three recorded suppliers; every prose field is a placeholder.
const LIST_V1 = [
  { name: 'HETZNER', purpose: 'PURPOSE_PLACEHOLDER' },
  { name: 'OVHCLOUD', purpose: 'PURPOSE_PLACEHOLDER' },
  { name: 'STRIPE', purpose: 'PURPOSE_PLACEHOLDER' },
];

const T_PUBLISHED = at('2026-09-01T09:00:00Z');
const T_EFFECTIVE = at('2026-10-01T09:00:00Z');
const NOW = at('2026-10-05T12:00:00Z');

let fixture: Fixture;
let owner: OwnerDb;
let tenant: TenantDb;
const scopeA = bindTenant(TENANT_A);
const scopeB = bindTenant(TENANT_B);

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  tenant = new TenantDb(fixture.tenant);
  await owner.publishDocument(
    { kind: 'terms', title: 'TERMS_TITLE', body: 'TERMS_BODY_V1', effectiveAt: T_EFFECTIVE },
    T_PUBLISHED
  );
  await owner.publishDocument(
    { kind: 'usage', title: 'USAGE_TITLE', body: 'USAGE_BODY_V1', effectiveAt: T_EFFECTIVE },
    T_PUBLISHED
  );
  await owner.publishDocument(
    {
      kind: 'subprocessors',
      title: 'SUBPROCESSORS_TITLE',
      body: 'SUBPROCESSORS_BODY',
      entries: LIST_V1,
      effectiveAt: T_EFFECTIVE,
    },
    T_PUBLISHED
  );
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
    expect(await tenant.currentDocuments(scopeA, at('2026-09-15T00:00:00Z'))).toEqual([]);
  });

  it('numbers versions one after another per kind', async () => {
    const view = await owner.publishDocument(
      {
        kind: 'usage',
        title: 'USAGE_TITLE',
        body: 'USAGE_BODY_V2',
        effectiveAt: at('2027-01-01T00:00:00Z'),
      },
      NOW
    );
    expect(view.version).toBe(2);
    // v2 is far in the future and is read again by later tests only at later times.
    expect((await tenant.currentDocument(scopeA, 'usage', NOW))?.version).toBe(1);
  });
});

describe('the notice period on a sub-processor entry', () => {
  const LIST_V2 = [
    ...LIST_V1,
    { name: 'NEW_SUBPROCESSOR_PLACEHOLDER', purpose: 'PURPOSE_PLACEHOLDER' },
  ];

  it('keeps a new entry out of the live list until its notice has elapsed', async () => {
    const published = await owner.publishDocument(
      {
        kind: 'subprocessors',
        title: 'SUBPROCESSORS_TITLE',
        body: 'SUBPROCESSORS_BODY',
        entries: LIST_V2,
        effectiveAt: new Date(NOW.getTime() + 30 * DAY),
      },
      NOW
    );
    expect(published.version).toBe(2);

    // Published and stored, but not live: the tenant still sees the old list.
    for (const offset of [0, 1, 29]) {
      const live = await tenant.currentDocument(
        scopeA,
        'subprocessors',
        new Date(NOW.getTime() + offset * DAY)
      );
      expect(live?.version).toBe(1);
      expect(live?.entries.map((e) => e.name)).not.toContain('NEW_SUBPROCESSOR_PLACEHOLDER');
    }
    const live = await tenant.currentDocument(
      scopeA,
      'subprocessors',
      new Date(NOW.getTime() + 30 * DAY)
    );
    expect(live?.version).toBe(2);
    expect(live?.entries.map((e) => e.name)).toContain('NEW_SUBPROCESSOR_PLACEHOLDER');
  });

  it('refuses a publication effective inside its notice, and the table refuses it too', async () => {
    await expect(
      owner.publishDocument(
        {
          kind: 'subprocessors',
          title: 'T',
          body: 'B',
          entries: LIST_V1,
          noticeDays: 30,
          effectiveAt: new Date(NOW.getTime() + 29 * DAY),
        },
        NOW
      )
    ).rejects.toBeInstanceOf(InvalidPublicationError);
    await expect(
      fixture.adminDb.insert(schema.documentVersion).values({
        kind: 'subprocessors',
        version: 9,
        title: 'T',
        body: 'B',
        entries: LIST_V1,
        publishedAt: NOW,
        effectiveAt: new Date(NOW.getTime() + 29 * DAY),
        noticeDays: 30,
      })
    ).rejects.toThrow();
  });

  it('refuses a sub-processor version with no notice, no entries, or entries on other kinds', async () => {
    const base = { title: 'T', body: 'B', effectiveAt: NOW };
    await expect(
      owner.publishDocument(
        { ...base, kind: 'subprocessors', entries: LIST_V1, noticeDays: 0 },
        NOW
      )
    ).rejects.toBeInstanceOf(InvalidPublicationError);
    await expect(
      owner.publishDocument({ ...base, kind: 'subprocessors' }, NOW)
    ).rejects.toBeInstanceOf(InvalidPublicationError);
    await expect(
      owner.publishDocument({ ...base, kind: 'terms', entries: LIST_V1 }, NOW)
    ).rejects.toBeInstanceOf(InvalidPublicationError);
    await expect(
      fixture.adminDb.insert(schema.documentVersion).values({
        kind: 'subprocessors',
        version: 9,
        title: 'T',
        body: 'B',
        entries: LIST_V1,
        publishedAt: NOW,
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
          publishedAt: NOW,
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
    const when = at('2026-10-05T12:30:00Z');
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
    const first = at('2026-10-05T12:31:00Z');
    await tenant.acceptDocument(
      scopeA,
      { kind: 'usage', version: 1, acceptedBy: 'SESSION_SUBJECT_A' },
      first
    );
    await tenant.acceptDocument(
      scopeA,
      { kind: 'usage', version: 1, acceptedBy: 'SESSION_SUBJECT_OTHER' },
      at('2026-10-05T13:00:00Z')
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
    await expect(
      fixture.tenant.query('BEGIN').then(async () => {
        try {
          await fixture.tenant.query('SET LOCAL ROLE portal_tenant');
          return await fixture.tenant.query('SELECT * FROM portal.document_acceptance');
        } finally {
          await fixture.tenant.query('ROLLBACK');
        }
      })
    ).rejects.toThrow(/no tenant bound/);
  });
});

describe('re-acceptance on a new version', () => {
  const TERMS_V2_EFFECTIVE = at('2026-10-10T00:00:00Z');
  const LATER = at('2026-10-12T00:00:00Z');

  it('asks again once a new version is in force, and leaves what was accepted as it was', async () => {
    await owner.publishDocument(
      {
        kind: 'terms',
        title: 'TERMS_TITLE_V2',
        body: 'TERMS_BODY_V2',
        effectiveAt: TERMS_V2_EFFECTIVE,
      },
      NOW
    );
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
