/**
 * Shared by the tests: a loopback fake Ghost, a token verifier written
 * independently of the package, and the leak matcher. Not a test file itself.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

// A distinctive, obviously fake key: nothing here is a real credential.
export const KEY_ID = '5eadbeefcafe0123456789ab';
export const SECRET = 'c0ffee00d15ea5e5facade0b5e55edd0decaf0badc0de0123456789abcdef012';
export const KEY = `${KEY_ID}:${SECRET}`;

const b64urlDecode = (/** @type {string} */ value) => Buffer.from(value, 'base64url');

/**
 * An independent verifier, written from Ghost's documented recipe (HS256 over
 * the hex-decoded secret, `kid` the key id, audience `/admin/`, five minutes at
 * most) with no code shared with the package. Returns false for anything wrong,
 * never throws.
 *
 * @param {string} token
 * @param {string} key
 * @returns {boolean}
 */
export function verifyToken(token, key) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, s] = /** @type {[string, string, string]} */ (parts);
    const [id, secret] = key.split(':');
    const header = JSON.parse(b64urlDecode(h).toString('utf8'));
    const payload = JSON.parse(b64urlDecode(p).toString('utf8'));
    if (header.alg !== 'HS256' || header.kid !== id) return false;
    if (payload.aud !== '/admin/') return false;
    if (!(payload.exp - payload.iat <= 300 && payload.exp > payload.iat)) return false;
    const expected = createHmac('sha256', Buffer.from(/** @type {string} */ (secret), 'hex'))
      .update(`${h}.${p}`)
      .digest();
    const given = b64urlDecode(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

/**
 * Everything that must never appear in an output: the whole key, the secret,
 * `id:secret`, every token the server saw, base64 of the key, base64 of the
 * decoded secret, and any 12-character window of the secret.
 *
 * @param {string} text
 * @param {{ key: string, tokens?: string[] }} what
 * @returns {string[]} the names of the leaks found
 */
export function findLeaks(text, { key, tokens = [] }) {
  const [id, secret] = /** @type {[string, string]} */ (key.split(':'));
  /** @type {Array<[string, string]>} */
  const needles = [
    ['the whole key', key],
    ['the secret', secret],
    ['id:secret', `${id}:${secret}`],
    ['base64 of the key', Buffer.from(key).toString('base64')],
    ['base64url of the key', Buffer.from(key).toString('base64url')],
    ['base64 of the decoded secret', Buffer.from(secret, 'hex').toString('base64')],
    ['base64url of the decoded secret', Buffer.from(secret, 'hex').toString('base64url')],
  ];
  for (const token of tokens) needles.push(['a token the server saw', token]);
  for (let start = 0; start + 12 <= secret.length; start += 1) {
    needles.push(['a 12-character window of the secret', secret.slice(start, start + 12)]);
  }
  const found = new Set();
  for (const [name, needle] of needles) {
    if (text.includes(needle)) found.add(name);
  }
  return [...found];
}

/**
 * @typedef {import('node:http').IncomingMessage} Req
 * @typedef {import('node:http').ServerResponse} Res
 * @typedef {{ method: string | undefined, url: string | undefined, authorization: string | undefined }} Seen
 */

/**
 * A loopback server. `handler` answers every request; each one is recorded.
 *
 * @param {(req: Req, res: Res) => void} handler
 */
export async function startFake(handler) {
  /** @type {Seen[]} */
  const seen = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    seen,
    /** Every token the server was given. */
    tokens: () =>
      seen.flatMap((entry) =>
        entry.authorization?.startsWith('Ghost ')
          ? [entry.authorization.slice('Ghost '.length)]
          : []
      ),
    async close() {
      for (const socket of sockets) /** @type {import('node:net').Socket} */ (socket).destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * @param {Res} res
 * @param {number} status
 * @param {unknown} body
 */
export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * A fake Ghost that answers the read-only endpoints the client uses, and
 * checks every request carries a valid token for `KEY`.
 *
 * @param {Req} req
 * @param {Res} res
 */
export function fakeGhost(req, res) {
  const token = req.headers.authorization?.replace(/^Ghost /, '') ?? '';
  if (req.method !== 'GET' || !verifyToken(token, KEY)) {
    return json(res, 401, { errors: [{ message: 'no' }] });
  }
  const url = new URL(req.url ?? '/', 'http://fake.test');
  const path = url.pathname;
  if (path === '/ghost/api/admin/members/') {
    const filter = url.searchParams.get('filter');
    if (filter !== null) {
      const wanted = /^email:'(.*)'$/.exec(filter)?.[1]?.replace(/\\(['\\])/g, '$1');
      return json(res, 200, {
        members: wanted === 'ada@example.test' ? [{ id: 'm1', email: 'ada@example.test' }] : [],
      });
    }
    return json(res, 200, { members: [], meta: { pagination: { total: 42 } } });
  }
  if (path === '/ghost/api/admin/newsletters/') {
    return json(res, 200, { newsletters: [{ id: 'n1', name: 'Weekly' }] });
  }
  if (path === '/ghost/api/admin/settings/') {
    return json(res, 200, {
      settings: [
        { key: 'title', value: 'A site' },
        { key: 'members_support_address', value: 'support@example.test' },
        { key: 'empty_setting', value: null },
      ],
    });
  }
  if (path === '/ghost/api/admin/members/upload/') {
    res.writeHead(200, { 'content-type': 'text/csv' });
    return res.end('id,email\nm1,ada@example.test\n');
  }
  return json(res, 404, { errors: [{ message: 'not found' }] });
}
