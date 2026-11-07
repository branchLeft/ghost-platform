/**
 * A read-only client for Ghost's Admin API.
 *
 * There is no write path in this file: the only method the transport ever
 * issues is GET. The key is held in a closure, validated once, and never put
 * in an error, a log line, or any enumerable property of the client.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isAdminApiKey } from './key.js';
import { adminApiToken } from './token.js';

const API_PREFIX = '/ghost/api/admin';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_EMAIL_LENGTH = 320;
const SETTING_KEY_PATTERN = /^[a-z0-9_]{1,64}$/;

/** A request that went wrong. The message is `METHOD /path -> outcome`, nothing else. */
export class AdminApiError extends Error {
  /**
   * @param {string} method
   * @param {string} path the path only: never a query string
   * @param {number | 'timeout' | 'network' | 'redirect' | 'bad-response'} outcome
   */
  constructor(method, path, outcome) {
    super(`${method} ${path} -> ${outcome}`);
    this.name = 'AdminApiError';
    this.method = method;
    this.path = path;
    this.outcome = outcome;
  }
}

/** The caller asked for something the client refuses before any socket opens. */
export class AdminApiConfigError extends Error {
  /** @param {string} message a reason; never a value the caller supplied */
  constructor(message) {
    super(message);
    this.name = 'AdminApiConfigError';
  }
}

/**
 * The base URL policy: https on any host; http only on a loopback name; no
 * userinfo, query or fragment. Returns the base without a trailing slash.
 *
 * @param {unknown} baseUrl
 * @returns {string}
 */
export function parseBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string') {
    throw new AdminApiConfigError('the base URL must be a string');
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AdminApiConfigError('the base URL is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AdminApiConfigError('the base URL must be https (or http on a loopback host)');
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new AdminApiConfigError('http is only allowed on a loopback host');
  }
  if (url.username !== '' || url.password !== '' || baseUrl.includes('@')) {
    throw new AdminApiConfigError('the base URL must not carry userinfo');
  }
  if (url.search !== '' || url.hash !== '' || baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new AdminApiConfigError('the base URL must not carry a query or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * @param {number} status
 * @returns {'ok' | 'redirect' | 'status'}
 */
function classify(status) {
  if (status >= 400 || status < 200) return 'status';
  if (status >= 300) return 'redirect';
  return 'ok';
}

/**
 * One GET. It never follows a redirect, and one deadline covers the whole
 * exchange from send to the last body byte: a socket-idle timer would be
 * reset by every trickled byte, so a stalled-but-chatty server could hold
 * the request open for ever.
 *
 * @param {{ url: URL, headers: Record<string, string>, timeoutMs: number, label: string }} call
 * @returns {Promise<Buffer>}
 */
function sendGet({ url, headers, timeoutMs, label }) {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (/** @type {() => void} */ action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const fail = (/** @type {number | 'timeout' | 'network' | 'redirect'} */ outcome) => {
      settle(() => reject(new AdminApiError('GET', label, outcome)));
      req.destroy();
    };
    const timer = setTimeout(() => fail('timeout'), timeoutMs);
    // Refused before it is sent (a header the runtime rejects, say): the same
    // shaped error as any other failure, never the runtime's own message.
    /** @type {import('node:http').ClientRequest} */
    let req;
    try {
      req = transport(url, { method: 'GET', headers, agent: false }, onResponse);
    } catch {
      settle(() => reject(new AdminApiError('GET', label, 'network')));
      return;
    }
    req.on('error', () => fail('network'));
    req.end();

    /** @param {import('node:http').IncomingMessage} res */
    function onResponse(res) {
      const status = res.statusCode ?? 0;
      const kind = classify(status);
      if (kind === 'redirect') return fail('redirect');
      if (kind === 'status') return fail(status);
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      res.on('data', (/** @type {Buffer} */ chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return fail('network');
        chunks.push(chunk);
      });
      res.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
      res.on('error', () => fail('network'));
      res.on('close', () => fail('network'));
    }
  });
}

/**
 * @param {string} email
 * @returns {string}
 */
function emailFilter(email) {
  const plausible =
    typeof email === 'string' &&
    email.length > 0 &&
    email.length <= MAX_EMAIL_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(email);
  if (!plausible) throw new AdminApiConfigError('not a plausible email address');
  const quoted = email.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `email:'${quoted}'`;
}

/**
 * @typedef {object} Options
 * @property {string} baseUrl
 * @property {string} key an Admin API key, `id:secret`
 * @property {number} [timeoutMs]
 * @property {() => number} [now] milliseconds, for the token's clock
 */

/**
 * @param {Options} options
 */
export function createAdminApiClient({
  baseUrl,
  key,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  const base = parseBaseUrl(baseUrl);
  if (!isAdminApiKey(key)) {
    throw new AdminApiConfigError('not a Ghost Admin API key');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AdminApiConfigError('the timeout must be a positive number of milliseconds');
  }

  /**
   * @param {string} resource
   * @param {Record<string, string>} params
   * @param {string} accept
   * @returns {Promise<{ body: Buffer, label: string }>}
   */
  async function get(resource, params, accept) {
    const url = new URL(`${base}${API_PREFIX}${resource}`);
    url.search = new URLSearchParams(params).toString();
    const token = adminApiToken(key, Math.floor(now() / 1000));
    const body = await sendGet({
      url,
      timeoutMs,
      label: url.pathname,
      headers: {
        Authorization: `Ghost ${token}`,
        Accept: accept,
        'Accept-Encoding': 'identity',
        Connection: 'close',
      },
    });
    return { body, label: url.pathname };
  }

  /**
   * @template T
   * @param {string} resource
   * @param {Record<string, string>} params
   * @param {(json: any) => T} pick throws on a body of the wrong shape
   * @returns {Promise<T>}
   */
  async function getJson(resource, params, pick) {
    const { body, label } = await get(resource, params, 'application/json');
    try {
      return pick(JSON.parse(body.toString('utf8')));
    } catch {
      throw new AdminApiError('GET', label, 'bad-response');
    }
  }

  /** @param {unknown} value @returns {asserts value is unknown[]} */
  function assertArray(value) {
    if (!Array.isArray(value)) throw new Error('not an array');
  }

  /** @param {string} settingKey */
  async function getSetting(settingKey) {
    if (typeof settingKey !== 'string' || !SETTING_KEY_PATTERN.test(settingKey)) {
      throw new AdminApiConfigError('not a plausible setting key');
    }
    return await getJson('/settings/', {}, (json) => {
      assertArray(json.settings);
      const found = /** @type {Array<{ key?: unknown, value?: unknown }>} */ (json.settings).find(
        (setting) => setting.key === settingKey
      );
      return found?.value ?? null;
    });
  }

  return Object.freeze({
    memberCount() {
      return getJson('/members/', { limit: '1' }, (json) => {
        const total = json.meta.pagination.total;
        if (!Number.isInteger(total) || total < 0) throw new Error('no total');
        return /** @type {number} */ (total);
      });
    },

    /** @param {string} email */
    async findMemberByEmail(email) {
      const filter = emailFilter(email);
      return await getJson('/members/', { filter, limit: '1' }, (json) => {
        assertArray(json.members);
        const wanted = email.toLowerCase();
        const found = /** @type {Array<{ email?: unknown }>} */ (json.members).find(
          (member) => typeof member.email === 'string' && member.email.toLowerCase() === wanted
        );
        return found ?? null;
      });
    },

    listNewsletters() {
      return getJson('/newsletters/', { limit: 'all' }, (json) => {
        assertArray(json.newsletters);
        return json.newsletters;
      });
    },

    getSetting,

    async membersSupportAddress() {
      const value = await getSetting('members_support_address');
      return typeof value === 'string' && value !== '' ? value : null;
    },

    async exportMembersCsv() {
      const { body } = await get('/members/upload/', { limit: 'all' }, 'text/csv');
      return body.toString('utf8');
    },
  });
}
