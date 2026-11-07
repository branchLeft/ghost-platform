import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { AdminApiConfigError, createAdminApiClient } from '../index.js';
import { parseBaseUrl } from '../src/client.js';
import { KEY } from './helpers.js';

/** @type {Array<[string, string]>} accepted URL, and the base it normalises to */
const ACCEPTED = [
  ['https://ghost.example.test', 'https://ghost.example.test'],
  ['https://ghost.example.test/', 'https://ghost.example.test'],
  ['https://ghost.example.test:8443/blog/', 'https://ghost.example.test:8443/blog'],
  ['http://localhost:2368', 'http://localhost:2368'],
  ['http://127.0.0.1:2368', 'http://127.0.0.1:2368'],
  ['http://[::1]:2368', 'http://[::1]:2368'],
];

const REFUSED = [
  'http://127.0.0.1.evil.test',
  'http://localhost.evil.test',
  'http://example.test',
  'http://10.0.0.1',
  'ftp://ghost.example.test',
  'file:///etc/passwd',
  'https://user@ghost.example.test',
  'https://user:pass@ghost.example.test',
  'http://user:pass@127.0.0.1:2368',
  'https://ghost.example.test/?a=b',
  'https://ghost.example.test/#fragment',
  'https://ghost.example.test?',
  'not a url',
  '',
];

for (const [input, expected] of ACCEPTED) {
  test(`accepts ${input}`, () => {
    assert.equal(parseBaseUrl(input), expected);
  });
}

for (const input of REFUSED) {
  test(`refuses ${JSON.stringify(input)}`, () => {
    assert.throws(
      () => parseBaseUrl(input),
      (error) => {
        assert.ok(error instanceof AdminApiConfigError);
        // The reason never repeats the URL: it could carry userinfo.
        assert.ok(input === '' || !error.message.includes(input));
        return true;
      }
    );
    assert.throws(() => createAdminApiClient({ baseUrl: input, key: KEY }), AdminApiConfigError);
  });
}

test('a non-string base URL is refused', () => {
  for (const input of [undefined, null, 42, {}]) {
    assert.throws(() => parseBaseUrl(input), AdminApiConfigError);
  }
});

test('a refused URL opens no socket', async () => {
  let connections = 0;
  const listener = createServer(() => {
    connections += 1;
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (listener.address());
  try {
    assert.throws(() =>
      createAdminApiClient({ baseUrl: `http://user:pass@127.0.0.1:${port}`, key: KEY })
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, 0);
  } finally {
    await new Promise((resolve) => listener.close(() => resolve(undefined)));
  }
});
