import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import {
  InvalidQueueItemError,
  TenantDb,
  assertTenantTablesIsolated,
  bindTenant,
  type ContentRef,
  type ContentSource,
  type HoldRequest,
  type LiveContent,
} from '../src/tenant/index.js';
import * as schema from '../src/schema.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

const NOW = new Date('2026-10-20T09:00:00Z');
// Distinctive enough that finding it anywhere at rest is unmistakable.
const COMMENT_TEXT = 'SENTINEL-COMMENT-TEXT you are all idiots';
const DISPLAY_NAME = 'SENTINEL-DISPLAY-NAME';
const POST_TITLE = 'SENTINEL-POST-TITLE';
const NOT_A_UUID = 'not-a-uuid';
const ABSENT_UUID = '99999999-9999-4999-8999-999999999999';

let fixture: Fixture;
let tenant: TenantDb;
const scopeA = bindTenant(TENANT_A);
const scopeB = bindTenant(TENANT_B);

const hold = (overrides: Partial<HoldRequest> = {}): HoldRequest => ({
  subjectKind: 'comment',
  subjectId: 'comment-1',
  memberId: 'member-1',
  classifiers: [{ name: 'harassment', confidence: 0.91, state: 'setting' }],
  decidedBy: 'safety-service',
  ...overrides,
});

class RecordingSource implements ContentSource {
  readonly refs: ContentRef[] = [];
  constructor(private readonly content: LiveContent | null) {}
  async fetch(ref: ContentRef): Promise<LiveContent | null> {
    this.refs.push(ref);
    return this.content;
  }
}

const live: LiveContent = {
  text: COMMENT_TEXT,
  memberDisplayName: DISPLAY_NAME,
  postTitle: POST_TITLE,
};

const allRows = () => fixture.adminDb.select().from(schema.moderationItem);

beforeAll(async () => {
  fixture = await createFixture();
  tenant = new TenantDb(fixture.tenant);
});

afterAll(async () => {
  await fixture.close();
});

describe('the moderation queue table', () => {
  it('is covered by the isolation check', () => {
    expect(() => assertTenantTablesIsolated(schema)).not.toThrow();
  });

  it('has exactly the stored fields and no column that could hold content', () => {
    expect(Object.keys(getTableColumns(schema.moderationItem)).sort()).toEqual([
      'classifiers',
      'decidedAt',
      'decidedBy',
      'id',
      'memberId',
      'status',
      'subjectId',
      'subjectKind',
      'tenantId',
    ]);
  });

  it('holds nothing for a tenant with nothing held', async () => {
    expect(await tenant.moderationItems(scopeA)).toEqual([]);
  });
});

describe('holding a classification', () => {
  it('stores the references, the classifiers and the decision as held', async () => {
    const item = await tenant.holdItem(scopeA, hold(), NOW);
    expect(item).toMatchObject({
      subjectKind: 'comment',
      subjectId: 'comment-1',
      memberId: 'member-1',
      classifiers: [{ name: 'harassment', confidence: 0.91, state: 'setting' }],
      status: 'held',
      decidedBy: 'safety-service',
    });
    expect(item.decidedAt.toISOString()).toBe(NOW.toISOString());
    expect(await tenant.moderationItems(scopeA)).toEqual([item]);
  });

  it('returns the existing item for a subject already held, without a duplicate', async () => {
    const again = await tenant.holdItem(
      scopeA,
      hold({ classifiers: [{ name: 'spam', confidence: 0.5, state: 'floor' }] }),
      new Date('2026-10-21T09:00:00Z')
    );
    expect(again.classifiers).toEqual([{ name: 'harassment', confidence: 0.91, state: 'setting' }]);
    expect(await tenant.moderationItems(scopeA)).toHaveLength(1);
  });

  it('lists newest decision first and filters by status', async () => {
    await tenant.holdItem(
      scopeA,
      hold({ subjectId: 'comment-2' }),
      new Date('2026-10-22T09:00:00Z')
    );
    const items = await tenant.moderationItems(scopeA);
    expect(items.map((i) => i.subjectId)).toEqual(['comment-2', 'comment-1']);
    expect(await tenant.moderationItems(scopeA, 'held')).toHaveLength(2);
    expect(await tenant.moderationItems(scopeA, 'released')).toEqual([]);
  });
});

describe('tenant scope (control case)', () => {
  it('never lists, reads or opens another tenant item', async () => {
    const b = await tenant.holdItem(scopeB, hold({ subjectId: 'comment-b' }), NOW);
    const listedA = await tenant.moderationItems(scopeA);
    expect(listedA.map((i) => i.subjectId)).not.toContain('comment-b');
    expect((await tenant.moderationItems(scopeB)).map((i) => i.subjectId)).toEqual(['comment-b']);

    expect(await tenant.moderationItem(scopeA, b.id)).toBeNull();
    const source = new RecordingSource(live);
    expect(await tenant.openModerationItem(scopeA, b.id, source)).toBeNull();
    expect(source.refs).toEqual([]);
  });

  it('keeps the same subject id apart per tenant', async () => {
    const a = await tenant.holdItem(scopeA, hold({ subjectId: 'shared-id' }), NOW);
    const b = await tenant.holdItem(scopeB, hold({ subjectId: 'shared-id' }), NOW);
    expect(a.id).not.toBe(b.id);
  });

  it('refuses a write naming another tenant even when the code is bypassed', async () => {
    await expect(
      tenant.run(scopeA, (tx) =>
        tx.insert(schema.moderationItem).values({
          tenantId: TENANT_B,
          subjectKind: 'comment',
          subjectId: 'smuggled',
          memberId: 'member-1',
          classifiers: [],
          status: 'held',
          decidedBy: 'safety-service',
          decidedAt: NOW,
        })
      )
    ).rejects.toThrow();
    expect((await allRows()).map((r) => r.subjectId)).not.toContain('smuggled');
  });

  it('treats a malformed or unknown id as absent', async () => {
    expect(await tenant.moderationItem(scopeA, NOT_A_UUID)).toBeNull();
    expect(await tenant.moderationItem(scopeA, ABSENT_UUID)).toBeNull();
  });
});

describe('content is fetched on open and never kept (control case)', () => {
  it('fetches live by reference and returns it without storing it', async () => {
    const [item] = await tenant.moderationItems(scopeA, 'held');
    const source = new RecordingSource(live);
    const opened = await tenant.openModerationItem(scopeA, item!.id, source);
    expect(opened?.content).toEqual({ state: 'present', ...live });
    expect(source.refs).toEqual([
      {
        tenantId: TENANT_A,
        subjectKind: item!.subjectKind,
        subjectId: item!.subjectId,
        memberId: item!.memberId,
      },
    ]);
  });

  it('shows an item whose source is gone as gone, not as an error', async () => {
    const [item] = await tenant.moderationItems(scopeA, 'held');
    const opened = await tenant.openModerationItem(scopeA, item!.id, new RecordingSource(null));
    expect(opened?.item.id).toBe(item!.id);
    expect(opened?.content).toEqual({ state: 'gone' });
  });

  it('does not mistake a failed fetch for gone content', async () => {
    const [item] = await tenant.moderationItems(scopeA, 'held');
    const failing: ContentSource = {
      fetch: () => Promise.reject(new Error('ghost unreachable')),
    };
    await expect(tenant.openModerationItem(scopeA, item!.id, failing)).rejects.toThrow(
      'ghost unreachable'
    );
  });

  it('leaves no comment text, name or post at rest after items have been opened', async () => {
    for (const item of await tenant.moderationItems(scopeA)) {
      await tenant.openModerationItem(scopeA, item.id, new RecordingSource(live));
    }
    const rows = await allRows();
    expect(rows.length).toBeGreaterThan(0);
    const atRest = JSON.stringify(rows);
    for (const secret of [COMMENT_TEXT, DISPLAY_NAME, POST_TITLE, 'SENTINEL', 'idiots']) {
      expect(atRest).not.toContain(secret);
    }
  });
});

describe('only references and scores can be stored (control case)', () => {
  const none = async () => (await allRows()).length;

  it.each([
    ['text in the subject id', { subjectId: COMMENT_TEXT }],
    ['text in the member id', { memberId: 'Jane Display Name' }],
    ['text in the deciding party', { decidedBy: 'a person who said you are all idiots' }],
    ['an over-long reference', { subjectId: 'a'.repeat(65) }],
    ['an unknown subject kind', { subjectKind: 'avatar' }],
    ['no classifiers', { classifiers: [] }],
    [
      'a classifier carrying text',
      { classifiers: [{ name: 'spam', confidence: 0.5, state: 'floor', text: COMMENT_TEXT }] },
    ],
    [
      'a classifier name that is a sentence',
      { classifiers: [{ name: COMMENT_TEXT, confidence: 0.5, state: 'floor' }] },
    ],
    ['a confidence above 1', { classifiers: [{ name: 'spam', confidence: 1.5, state: 'floor' }] }],
    [
      'a state that is neither floor nor setting',
      { classifiers: [{ name: 'spam', confidence: 0.5, state: COMMENT_TEXT }] },
    ],
  ])('refuses %s and writes nothing', async (_label, override) => {
    const before = await none();
    await expect(
      tenant.holdItem(
        scopeA,
        hold({ subjectId: 'refused-1', ...(override as Partial<HoldRequest>) }),
        NOW
      )
    ).rejects.toBeInstanceOf(InvalidQueueItemError);
    expect(await none()).toBe(before);
  });

  it('is refused by the table itself when the code is bypassed', async () => {
    const before = await none();
    await expect(
      tenant.run(scopeA, (tx) =>
        tx.insert(schema.moderationItem).values({
          tenantId: TENANT_A,
          subjectKind: 'comment',
          subjectId: 'bypass',
          memberId: COMMENT_TEXT,
          classifiers: [],
          status: 'held',
          decidedBy: 'safety-service',
          decidedAt: NOW,
        })
      )
    ).rejects.toThrow();
    expect(await none()).toBe(before);
  });
});
