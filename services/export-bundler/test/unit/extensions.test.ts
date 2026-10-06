import { describe, expect, it } from 'vitest';
import {
  collectComments,
  collectExtensions,
  collectMedia,
  collectMembers,
  type ExtensionDeps,
} from '../../src/extensions.js';
import {
  GhostExportError,
  type Collection,
  type GhostExportClient,
} from '../../src/ghostExportClient.js';

const BASE = 'https://media.test/opaque-t1';

function client(over: Partial<GhostExportClient> = {}): GhostExportClient {
  return {
    fetchContentAndSettings: async () => {
      throw new Error('not used');
    },
    fetchPostAnalytics: async () => {
      throw new Error('not used');
    },
    fetchMembersCsv: async () => ({
      filename: 'm.csv',
      contentType: 'text/csv',
      body: Buffer.from('id\nm1\n'),
    }),
    fetchMembers: async () => ({
      total: 2,
      items: [
        { id: 'm1', subscriptions: [{ id: 's1' }, { id: 's2' }] },
        { id: 'm2', subscriptions: [] },
      ],
    }),
    fetchComments: async () => ({
      total: 2,
      items: [
        { id: 'c1', status: 'published', count: { reports: 0 } },
        { id: 'c2', status: 'hidden', count: { reports: 2 } },
      ],
    }),
    fetchCommentReports: async () => ({ total: 2, items: [{ id: 'r1' }, { id: 'r2' }] }),
    ...over,
  };
}

function deps(over: Partial<ExtensionDeps> = {}): ExtensionDeps {
  return {
    client: client(),
    mediaProbe: { head: async () => ({ exists: true, bytes: 3 }) },
    baseUrl: 'http://127.0.0.1:1',
    tenantId: 'tenant-1',
    media: {
      baseUrl: BASE,
      erasureDate: '2030-01-01',
    },
    nowSeconds: 1_800_000_000,
    contentJson: `{"a":"${BASE}/a.png","b":"${BASE}/b.png"}`,
    ...over,
  };
}

const rejects = (err: Error) => async (): Promise<never> => {
  throw err;
};

describe('collectMembers', () => {
  it('is complete when what was read is what Ghost counts, and carries subscription state', async () => {
    const out = await collectMembers(deps());
    expect(out.report).toMatchObject({ status: 'complete', expected: 2, present: 2, notes: [] });
    expect(out.report.info).toEqual(['2 subscription records included']);
    expect(out.files.map((f) => f.name)).toEqual(['members.json', 'members.csv']);
    expect(JSON.parse(String(out.files[0]?.data)).members).toHaveLength(2);
  });

  it('is PARTIAL, not complete, when fewer members were read than Ghost counts', async () => {
    const out = await collectMembers(
      deps({
        client: client({
          fetchMembers: async () => ({ total: 5, items: [{ id: 'm1', subscriptions: [] }] }),
        }),
      })
    );
    expect(out.report.status).toBe('partial');
    expect(out.report.notes).toEqual(['read 1 members, Ghost counts 5']);
    expect(out.report.expected).toBe(5);
    expect(out.report.present).toBe(1);
  });

  it('is partial when a row has no id, a repeated id or no subscription list', async () => {
    const out = await collectMembers(
      deps({
        client: client({
          fetchMembers: async () => ({
            total: 3,
            items: [
              { id: 'm1', subscriptions: [] },
              { id: 'm1', subscriptions: [] },
              { email: 'x' },
            ],
          }),
        }),
      })
    );
    expect(out.report.status).toBe('partial');
    expect(out.report.notes).toEqual([
      '2 member rows have a missing or repeated id',
      '1 member rows carry no subscription list',
    ]);
  });

  it.each([
    [
      'the members read',
      {
        fetchMembers: rejects(
          new GhostExportError(
            '/ghost/api/admin/members/?limit=100',
            500,
            'member@secret.test boom'
          )
        ),
      },
    ],
    ['the CSV read', { fetchMembersCsv: rejects(new Error('csv down')) }],
  ])(
    'is FAILED, with no files, when %s fails -- and names the kind of failure, never the response body',
    async (_l, over) => {
      const out = await collectMembers(deps({ client: client(over) }));
      expect(out.report.status).toBe('failed');
      expect(out.files).toEqual([]);
      expect(JSON.stringify(out.report)).not.toContain('member@secret.test');
    }
  );

  it('names the route and status for a Ghost failure, only the kind otherwise', async () => {
    const a = await collectMembers(
      deps({
        client: client({ fetchMembers: rejects(new GhostExportError('/r?x=1', 403, 'body')) }),
      })
    );
    expect(a.report.notes).toEqual(['GhostExportError on /r (403)']);
    const b = await collectMembers(
      deps({
        client: client({
          fetchMembers: async () => {
            throw 'str';
          },
        }),
      })
    );
    expect(b.report.notes).toEqual(['unknown failure']);
  });
});

describe('collectComments', () => {
  it("carries each comment's moderation state alongside its text, including hidden", async () => {
    const out = await collectComments(deps());
    expect(out.report).toMatchObject({ status: 'complete', expected: 2, present: 2 });
    expect(out.report.info).toEqual(['moderation states: 1 published, 1 hidden']);
    const { comments } = JSON.parse(String(out.files[0]?.data)) as {
      comments: Record<string, any>[];
    };
    expect(comments.map((c) => [c.id, c.moderation.status])).toEqual([
      ['c1', 'published'],
      ['c2', 'hidden'],
    ]);
    expect(comments[1]?.moderation).toMatchObject({
      reportCount: 2,
      reportsComplete: true,
      reports: [{ id: 'r1' }, { id: 'r2' }],
    });
    expect(comments[0]?.moderation.reports).toEqual([]);
  });

  it('is partial when fewer comments were read than Ghost counts', async () => {
    const out = await collectComments(
      deps({
        client: client({
          fetchComments: async () => ({ total: 9, items: [{ id: 'c1', status: 'published' }] }),
        }),
      })
    );
    expect(out.report.status).toBe('partial');
    expect(out.report.notes).toContain('read 1 comments, Ghost counts 9');
  });

  it('is partial, with a null status in the record, for a comment whose moderation state is unreadable', async () => {
    const out = await collectComments(
      deps({
        client: client({
          fetchComments: async () => ({
            total: 2,
            items: [{ id: 'c1', status: 'weird' }, { id: 'c2' }],
          }),
        }),
      })
    );
    expect(out.report.status).toBe('partial');
    expect(out.report.notes).toContain('2 comments have no readable moderation status');
    const { comments } = JSON.parse(String(out.files[0]?.data)) as {
      comments: Record<string, any>[];
    };
    expect(comments.map((c) => c.moderation.status)).toEqual([null, null]);
  });

  it.each([
    ['the reports request fails', { fetchCommentReports: rejects(new Error('x')) }],
    [
      'the reports fall short of the count the comment carries',
      {
        fetchCommentReports: async (): Promise<Collection> => ({ total: 2, items: [{ id: 'r1' }] }),
      },
    ],
    [
      'Ghost reports a different number of reporters',
      {
        fetchCommentReports: async (): Promise<Collection> => ({ total: 1, items: [{ id: 'r1' }] }),
      },
    ],
  ])('is partial when %s', async (_l, over) => {
    const out = await collectComments(deps({ client: client(over) }));
    expect(out.report.status).toBe('partial');
    expect(out.report.notes).toEqual(['1 comments have reports that could not be read in full']);
    const { comments } = JSON.parse(String(out.files[0]?.data)) as {
      comments: Record<string, any>[];
    };
    expect(comments[1]?.moderation.reportsComplete).toBe(false);
  });

  it('is failed, with no files, when the comments cannot be read', async () => {
    const out = await collectComments(
      deps({ client: client({ fetchComments: rejects(new Error('no')) }) })
    );
    expect(out.report).toMatchObject({ status: 'failed', expected: null, present: 0 });
    expect(out.files).toEqual([]);
  });
});

describe('collectMedia', () => {
  it('lists the public address of every referenced object, with the erasure date, inside the archive only', async () => {
    const out = await collectMedia(deps());
    expect(out.report).toMatchObject({ status: 'complete', expected: 2, present: 2, notes: [] });
    expect(out.files.map((f) => f.name)).toEqual(['media_addresses.json']);
    const body = JSON.parse(String(out.files[0]?.data));
    expect(body.erasureDate).toBe('2030-01-01');
    expect(body.addresses.map((a: { url: string }) => a.url)).toEqual([
      `${BASE}/a.png`,
      `${BASE}/b.png`,
    ]);
    expect(out.report.info).toContain(
      'public addresses only, no media bytes: they stop working after 2030-01-01'
    );
    // The manifest beside the archive carries the date but no address.
    expect(JSON.stringify(out.report)).not.toMatch(/https?:/);
  });

  it('is partial when an object the content references is not in storage or cannot be checked', async () => {
    const out = await collectMedia(
      deps({
        mediaProbe: {
          head: async (url) => {
            if (url.endsWith('/a.png')) return { exists: false, bytes: null };
            throw new Error('timeout');
          },
        },
      })
    );
    expect(out.report.status).toBe('partial');
    expect(out.report.notes).toEqual([
      '1 referenced objects are not in storage',
      '1 referenced objects could not be checked',
    ]);
    expect(out.report.present).toBe(0);
    expect(JSON.parse(String(out.files[0]?.data)).addresses).toEqual([]);
  });

  it('is failed when the tenant has no object-storage media address', async () => {
    const out = await collectMedia(deps({ media: { ...deps().media, baseUrl: null } }));
    expect(out.report.status).toBe('failed');
    expect(out.files).toEqual([]);
  });

  it('is failed when the media base is not one tenant prefix', async () => {
    const out = await collectMedia(
      deps({ media: { ...deps().media, baseUrl: 'https://media.test/' } })
    );
    expect(out.report.status).toBe('failed');
  });

  it("never lists another tenant's object, and counts it as refused", async () => {
    const out = await collectMedia(
      deps({ contentJson: `{"a":"${BASE}/a.png","x":"https://media.test/opaque-t2/x.png"}` })
    );
    const body = JSON.parse(String(out.files[0]?.data));
    expect(body.addresses.map((a: { key: string }) => a.key)).toEqual(['a.png']);
    expect(JSON.stringify(body.addresses)).not.toContain('opaque-t2');
    expect(body.refused).toEqual([
      { reference: 'https://media.test/opaque-t2/x.png', reason: 'outside-tenant-prefix' },
    ]);
    expect(out.report.info[0]).toBe(
      '1 references under another prefix were refused and not listed'
    );
  });
});

describe('the erasure date', () => {
  it.each(['2020-01-01', 'soon', '2030-02-30'])(
    'FAILS the media extension for the unusable erasure date %j, listing nothing',
    async (erasureDate) => {
      const out = await collectMedia(deps({ media: { ...deps().media, erasureDate } }));
      expect(out.report.status).toBe('failed');
      expect(out.report.notes).toEqual(['ErasureDateError']);
      expect(out.files).toEqual([]);
    }
  );
});

describe('collectExtensions', () => {
  it('runs all three, and one failing does not stop the others', async () => {
    const out = await collectExtensions(
      deps({ client: client({ fetchMembers: rejects(new Error('x')) }) })
    );
    expect(out.map((o) => [o.report.name, o.report.status])).toEqual([
      ['media', 'complete'],
      ['members_and_subscriptions', 'failed'],
      ['comments', 'complete'],
    ]);
  });
});
