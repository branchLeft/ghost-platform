// Verifies an export by using it: the export is taken from a seeded Ghost,
// put into a different, fresh Ghost, and the named items are looked for
// there. The control is the same verifier pointed at a fresh Ghost that
// imported nothing, which must fail on every item: an empty Ghost answers
// 200 to everything, so a verifier that passes there proves nothing.
//
// Usage:
//   IMAGE=ghost-platform:ci node --test test/image/export-reimport.image.test.mjs
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GhostAdmin } from './ghost-admin.mjs';
import { GhostContainer } from './ghost-container.mjs';
import {
  NAMED_MEMBERS,
  NAMED_POSTS,
  NAMED_TAGS,
  NAMED_SETTINGS,
  PARTS,
  dropPostFromContent,
  exportParts,
  importParts,
  verifyNamedItems,
} from './export-parts.mjs';

const PASSWORD = 'Xk9-export-reimport-image-test-1234';
const containers = [];

async function freshGhost(email, siteTitle) {
  const container = await GhostContainer.start();
  containers.push(container);
  const admin = new GhostAdmin(container);
  await admin.setupOwner({ email, password: PASSWORD, siteTitle });
  return { container, admin };
}

async function discard({ container }) {
  container.remove();
  containers.splice(containers.indexOf(container), 1);
}

// The members import is a background job; poll until the first named member
// shows, then let the verifier judge them all.
async function settle(admin) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const members = await admin.listMembers();
    if (members.some((m) => m.email === NAMED_MEMBERS[0].email)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe('an export, re-imported into a fresh Ghost', { timeout: 900_000 }, () => {
  let exported;
  let sourceFailures;

  before(async () => {
    const source = await freshGhost('owner-source@example.test', 'SOURCE_PLACEHOLDER_TITLE');
    for (const part of PARTS) await part.seed(source.admin);
    sourceFailures = await verifyNamedItems(source.admin);
    exported = await exportParts(source.admin);
    await discard(source);
  });

  after(() => {
    for (const container of containers) container.remove();
  });

  it('starts from a source that really holds every named item', () => {
    assert.deepEqual(sourceFailures, [], 'the seed must hold what the verifier looks for');
  });

  it('CONTROL: the verifier fails on every named item against a Ghost that imported nothing', async () => {
    const empty = await freshGhost('owner-empty@example.test', 'EMPTY_PLACEHOLDER_TITLE');
    try {
      const home = await empty.container.request('GET', '/');
      assert.equal(
        home.status,
        200,
        'an empty Ghost serves 200, which is why status proves nothing'
      );
      const failures = await verifyNamedItems(empty.admin);
      for (const post of NAMED_POSTS)
        assert.ok(
          failures.some((f) => f.includes(`post ${post.slug} is missing`)),
          `post ${post.slug}`
        );
      for (const tag of NAMED_TAGS)
        assert.ok(
          failures.some((f) => f.includes(`tag ${tag.slug} is missing`)),
          `tag ${tag.slug}`
        );
      for (const member of NAMED_MEMBERS)
        assert.ok(
          failures.some((f) => f.includes(`member ${member.email} is missing`)),
          `member ${member.email}`
        );
      for (const key of Object.keys(NAMED_SETTINGS))
        assert.ok(
          failures.some((f) => f.includes(`setting ${key} `)),
          `setting ${key}`
        );
    } finally {
      await discard(empty);
    }
  });

  it('every named post, tag, member and setting survives the re-import', async () => {
    const target = await freshGhost('owner-target@example.test', 'TARGET_PLACEHOLDER_TITLE');
    try {
      await importParts(target.admin, exported);
      await settle(target.admin);
      assert.deepEqual(await verifyNamedItems(target.admin), []);
    } finally {
      await discard(target);
    }
  });

  it('SABOTAGE: an export that lost one post is caught, naming that post and no other', async () => {
    const target = await freshGhost('owner-lossy@example.test', 'LOSSY_PLACEHOLDER_TITLE');
    try {
      const lossy = {
        ...exported,
        content: dropPostFromContent(exported.content, 'named-post-draft'),
      };
      await importParts(target.admin, lossy);
      await settle(target.admin);
      const failures = await verifyNamedItems(target.admin);
      assert.deepEqual(failures, ['content: post named-post-draft is missing']);
    } finally {
      await discard(target);
    }
  });
});
