// The verifier's own logic, with no Docker: a fake admin that holds exactly
// what it is told to hold.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAMED_MEMBERS,
  NAMED_POSTS,
  NAMED_SETTINGS,
  NAMED_TAGS,
  dropPostFromContent,
  verifyNamedItems,
} from './export-parts.mjs';

function fullAdmin(overrides = {}) {
  return {
    listPosts: async () =>
      NAMED_POSTS.map((p) => ({
        slug: p.slug,
        title: p.title,
        status: p.status,
        html: `<p>${p.body}</p>`,
        tags: [{ slug: p.tag }],
      })),
    listTags: async () => NAMED_TAGS.map((t) => ({ ...t })),
    listMembers: async () =>
      NAMED_MEMBERS.map((m) => ({
        email: m.email,
        name: m.name,
        note: m.note,
        labels: [{ name: m.label }],
      })),
    settingsMap: async () => ({ ...NAMED_SETTINGS }),
    ...overrides,
  };
}

describe('verifyNamedItems', () => {
  it('passes when every named item is present and intact', async () => {
    assert.deepEqual(await verifyNamedItems(fullAdmin()), []);
  });

  it('fails every item against an admin holding only defaults', async () => {
    const empty = fullAdmin({
      listPosts: async () => [
        { slug: 'coming-soon', title: 'Coming soon', status: 'published', html: '', tags: [] },
      ],
      listTags: async () => [{ slug: 'news', name: 'News', description: null }],
      listMembers: async () => [],
      settingsMap: async () => ({ title: 'Default', description: 'Default' }),
    });
    const failures = await verifyNamedItems(empty);
    assert.equal(
      failures.length,
      NAMED_POSTS.length +
        NAMED_TAGS.length +
        NAMED_MEMBERS.length +
        Object.keys(NAMED_SETTINGS).length
    );
  });

  it('catches a post that survived but lost its title, status, body or tag', async () => {
    const damaged = fullAdmin({
      listPosts: async () => [
        {
          slug: NAMED_POSTS[0].slug,
          title: 'OTHER',
          status: 'draft',
          html: '<p>gone</p>',
          tags: [],
        },
        ...(await fullAdmin().listPosts()).slice(1),
      ],
    });
    const failures = await verifyNamedItems(damaged);
    assert.equal(failures.length, 4);
    assert.ok(failures.every((f) => f.startsWith('content: post named-post-published')));
  });

  it('catches a tag, member and setting that survived with the wrong value', async () => {
    const damaged = fullAdmin({
      listTags: async () => NAMED_TAGS.map((t) => ({ ...t, name: 'X', description: null })),
      listMembers: async () =>
        NAMED_MEMBERS.map((m) => ({ email: m.email, name: 'X', note: null, labels: [] })),
      settingsMap: async () => ({ title: 'X', description: NAMED_SETTINGS.description }),
    });
    const failures = await verifyNamedItems(damaged);
    assert.equal(failures.filter((f) => f.startsWith('content: tag')).length, 4);
    assert.equal(failures.filter((f) => f.startsWith('members:')).length, 6);
    assert.deepEqual(
      failures.filter((f) => f.startsWith('content: setting')),
      ['content: setting title is "X", not "NAMED_SITE_TITLE"']
    );
  });
});

describe('dropPostFromContent', () => {
  const sample = Buffer.from(
    JSON.stringify({
      db: [
        {
          data: {
            posts: [
              { id: 'a', slug: 'one' },
              { id: 'b', slug: 'two' },
            ],
            posts_tags: [{ post_id: 'a' }, { post_id: 'b' }],
          },
        },
      ],
    })
  );

  it('removes the post and its join rows, and nothing else', () => {
    const data = JSON.parse(dropPostFromContent(sample, 'one').toString()).db[0].data;
    assert.deepEqual(data.posts, [{ id: 'b', slug: 'two' }]);
    assert.deepEqual(data.posts_tags, [{ post_id: 'b' }]);
  });

  it('refuses to report a drop that dropped nothing', () => {
    assert.throws(() => dropPostFromContent(sample, 'absent'), /no post absent/);
  });
});
