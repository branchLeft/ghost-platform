import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { after, before, test } from 'node:test';
import { AdminApiConfigError, AdminApiError, createAdminApiClient } from '../index.js';
import { fakeGhost, findLeaks, json, KEY, startFake, verifyToken } from './helpers.js';

/** @type {Awaited<ReturnType<typeof startFake>>} */
let fake;
before(async () => {
  fake = await startFake(fakeGhost);
});
after(async () => {
  await fake.close();
});

const clientFor = (/** @type {string} */ url, extra = {}) =>
  createAdminApiClient({ baseUrl: url, key: KEY, ...extra });

test('memberCount, listNewsletters, getSetting and membersSupportAddress read what Ghost says', async () => {
  const client = clientFor(fake.url);
  assert.equal(await client.memberCount(), 42);
  assert.deepEqual(await client.listNewsletters(), [{ id: 'n1', name: 'Weekly' }]);
  assert.equal(await client.getSetting('title'), 'A site');
  assert.equal(await client.getSetting('not_there'), null);
  assert.equal(await client.getSetting('empty_setting'), null);
  assert.equal(await client.membersSupportAddress(), 'support@example.test');
});

test('membersSupportAddress is null when the setting is empty', async () => {
  const empty = await startFake((req, res) =>
    json(res, 200, { settings: [{ key: 'members_support_address', value: '' }] })
  );
  try {
    assert.equal(await clientFor(empty.url).membersSupportAddress(), null);
  } finally {
    await empty.close();
  }
});

test('findMemberByEmail finds a member, returns null for none, and quotes the filter', async () => {
  const client = clientFor(fake.url);
  assert.deepEqual(await client.findMemberByEmail('ada@example.test'), {
    id: 'm1',
    email: 'ada@example.test',
  });
  assert.equal(await client.findMemberByEmail('nobody@example.test'), null);

  const before = fake.seen.length;
  await client.findMemberByEmail("o'brien\\x@example.test");
  const sent = new URL(fake.seen[before]?.url ?? '', 'http://fake.test');
  assert.equal(sent.searchParams.get('filter'), "email:'o\\'brien\\\\x@example.test'");
});

test('findMemberByEmail refuses what is not an email before any request', async () => {
  const client = clientFor(fake.url);
  const before = fake.seen.length;
  for (const bad of ['', 'a\nb@example.test', 'x'.repeat(400), undefined]) {
    await assert.rejects(
      () => client.findMemberByEmail(/** @type {any} */ (bad)),
      (error) => error instanceof AdminApiConfigError
    );
  }
  assert.equal(fake.seen.length, before);
});

test('exportMembersCsv returns the CSV text', async () => {
  assert.equal(await clientFor(fake.url).exportMembersCsv(), 'id,email\nm1,ada@example.test\n');
});

test('every request is a GET with a fresh token the independent verifier accepts', async () => {
  const seen = await startFake(fakeGhost);
  let clock = 1_800_000_000_000;
  try {
    const client = clientFor(seen.url, { now: () => clock });
    await client.memberCount();
    clock += 60_000;
    await client.memberCount();
    assert.equal(seen.seen.length, 2);
    assert.ok(seen.seen.every((entry) => entry.method === 'GET'));
    const tokens = seen.tokens();
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
    assert.ok(tokens.every((token) => verifyToken(token, KEY)));
    const iat = tokens.map(
      (token) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).iat
    );
    assert.deepEqual(iat, [1_800_000_000, 1_800_000_060]);
  } finally {
    await seen.close();
  }
});

test('the client has no write path: only methods that read', () => {
  assert.deepEqual(Object.keys(clientFor(fake.url)).sort(), [
    'exportMembersCsv',
    'findMemberByEmail',
    'getSetting',
    'listNewsletters',
    'memberCount',
    'membersSupportAddress',
  ]);
});

test('the key is not on the client in any form a log or a JSON dump would show', () => {
  const client = clientFor(fake.url);
  const shown = [
    JSON.stringify(client),
    String(client),
    inspect(client, { depth: 5, showHidden: true }),
    Object.entries(client).join(','),
  ].join('\n');
  assert.deepEqual(findLeaks(shown, { key: KEY }), []);
});

test('an error carries method, path and status only', async () => {
  const failing = await startFake((req, res) => json(res, 500, { errors: [{ message: KEY }] }));
  try {
    const client = clientFor(failing.url);
    await assert.rejects(
      () => client.memberCount(),
      (error) => {
        assert.ok(error instanceof AdminApiError);
        assert.equal(error.message, 'GET /ghost/api/admin/members/ -> 500');
        assert.equal(error.outcome, 500);
        // The response body (which here even holds the key) is not in the error.
        assert.deepEqual(findLeaks(`${error.message}\n${error.stack}`, { key: KEY }), []);
        return true;
      }
    );
    await assert.rejects(
      () => client.findMemberByEmail('private.person@example.test'),
      (error) => {
        assert.ok(error instanceof AdminApiError);
        assert.equal(error.message, 'GET /ghost/api/admin/members/ -> 500');
        assert.ok(!error.stack?.includes('private.person'));
        assert.ok(!error.message.includes('?'));
        return true;
      }
    );
  } finally {
    await failing.close();
  }
});

test('a 401 is reported as a 401', async () => {
  const denied = await startFake((req, res) => json(res, 401, {}));
  try {
    await assert.rejects(
      () => clientFor(denied.url).listNewsletters(),
      (error) =>
        error instanceof AdminApiError &&
        error.message === 'GET /ghost/api/admin/newsletters/ -> 401'
    );
  } finally {
    await denied.close();
  }
});

test('a body of the wrong shape is a bad-response error, not a crash or a wrong number', async () => {
  const odd = await startFake((req, res) => json(res, 200, { meta: {} }));
  try {
    await assert.rejects(
      () => clientFor(odd.url).memberCount(),
      (error) =>
        error instanceof AdminApiError &&
        error.message === 'GET /ghost/api/admin/members/ -> bad-response'
    );
  } finally {
    await odd.close();
  }
});

test('nothing listening is a network error', async () => {
  const gone = await startFake(fakeGhost);
  const url = gone.url;
  await gone.close();
  await assert.rejects(
    () => clientFor(url).memberCount(),
    (error) =>
      error instanceof AdminApiError && error.message === 'GET /ghost/api/admin/members/ -> network'
  );
});

test('a base URL with a path prefix keeps it', async () => {
  const prefixed = await startFake((req, res) => json(res, 200, { echo: req.url }));
  try {
    const client = clientFor(`${prefixed.url}/blog/`);
    await assert.rejects(() => client.memberCount());
    assert.equal(prefixed.seen[0]?.url, '/blog/ghost/api/admin/members/?limit=1');
  } finally {
    await prefixed.close();
  }
});

test('a body past the cap is cut off', async () => {
  const big = await startFake((req, res) => {
    res.writeHead(200, { 'content-type': 'text/csv' });
    const chunk = Buffer.alloc(1024 * 1024, 97);
    let sent = 0;
    const write = () => {
      while (sent < 20) {
        sent += 1;
        if (!res.write(chunk)) return res.once('drain', write);
      }
      res.end();
    };
    write();
  });
  try {
    await assert.rejects(
      () => clientFor(big.url).exportMembersCsv(),
      (error) =>
        error instanceof AdminApiError &&
        error.message === 'GET /ghost/api/admin/members/upload/ -> network'
    );
  } finally {
    await big.close();
  }
});

test('one total deadline cuts off a server that trickles a byte at a time for ever', async () => {
  /** @type {NodeJS.Timeout | undefined} */
  let drip;
  const trickle = await startFake((req, res) => {
    res.writeHead(200, { 'content-type': 'text/csv' });
    drip = setInterval(() => res.write('x'), 20);
    res.on('close', () => clearInterval(drip));
  });
  try {
    const started = Date.now();
    const outcome = await Promise.race([
      clientFor(trickle.url, { timeoutMs: 300 })
        .exportMembersCsv()
        .then(
          () => 'resolved',
          (error) => error
        ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3000)),
    ]);
    assert.ok(outcome instanceof AdminApiError, `got ${String(outcome)}`);
    assert.equal(outcome.message, 'GET /ghost/api/admin/members/upload/ -> timeout');
    assert.ok(Date.now() - started < 2500);
  } finally {
    clearInterval(drip);
    await trickle.close();
  }
});

test('a server that never answers is cut off at the deadline', async () => {
  const silent = await startFake(() => {});
  try {
    await assert.rejects(
      () => clientFor(silent.url, { timeoutMs: 200 }).memberCount(),
      (error) => error instanceof AdminApiError && error.outcome === 'timeout'
    );
  } finally {
    await silent.close();
  }
});

test('a key that is not a key, or a bad timeout, is refused without echoing it', () => {
  for (const key of ['nope-distinctive-wrong-value', '', undefined]) {
    assert.throws(
      () => createAdminApiClient({ baseUrl: fake.url, key: /** @type {any} */ (key) }),
      (error) => {
        assert.ok(error instanceof AdminApiConfigError);
        assert.equal(error.message, 'not a Ghost Admin API key');
        return true;
      }
    );
  }
  for (const timeoutMs of [0, -1, Number.NaN]) {
    assert.throws(() => clientFor(fake.url, { timeoutMs }), AdminApiConfigError);
  }
});
