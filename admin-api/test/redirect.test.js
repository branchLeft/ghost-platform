import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdminApiError, createAdminApiClient } from '../index.js';
import { fakeGhost, KEY, startFake } from './helpers.js';

for (const status of [301, 302, 307, 308]) {
  test(`a ${status} is an error and the redirect is not followed`, async () => {
    const fake = await startFake((req, res) => {
      if (req.url?.startsWith('/followed')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ meta: { pagination: { total: 1 } } }));
      }
      res.writeHead(status, { location: '/followed/ghost/api/admin/members/?limit=1' });
      res.end();
    });
    try {
      const client = createAdminApiClient({ baseUrl: fake.url, key: KEY });
      await assert.rejects(
        () => client.memberCount(),
        (error) => {
          assert.ok(error instanceof AdminApiError);
          assert.equal(error.message, 'GET /ghost/api/admin/members/ -> redirect');
          return true;
        }
      );
      // Give a wrongly-followed redirect time to arrive, then count.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(fake.seen.length, 1, 'a second request arrived');
    } finally {
      await fake.close();
    }
  });
}

test('the same route without a redirect succeeds (the green control)', async () => {
  const fake = await startFake(fakeGhost);
  try {
    const client = createAdminApiClient({ baseUrl: fake.url, key: KEY });
    assert.equal(await client.memberCount(), 42);
    assert.equal(fake.seen.length, 1);
  } finally {
    await fake.close();
  }
});
