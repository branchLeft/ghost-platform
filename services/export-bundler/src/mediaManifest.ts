import {
  assertSafeObjectKey,
  signMediaLink,
  MediaLinkError,
  type MediaLinkSigner,
} from './mediaLinks.js';

/**
 * The media half of the export: the archive carries a manifest of
 * time-bounded links, never the bytes. Live media sits in shared shard
 * buckets behind our gateway under one opaque prefix per tenant, and the
 * tenant holds no storage key, so a bucket-to-bucket copy with the tenant's
 * own credentials does not exist (page 20 of the storage design).
 *
 * The tenant's scope is the base URL its own rendered environment serves
 * media from (`cdnUrl`). A reference is signed only if it lies under that
 * base. A reference on the same origin but under another prefix is another
 * tenant's object on a shared shard: it is refused and named, never signed.
 */

export interface RefusedReference {
  readonly reference: string;
  readonly reason: 'outside-tenant-prefix' | 'unsafe-key';
}

export interface ReferenceScan {
  readonly keys: readonly string[];
  readonly refused: readonly RefusedReference[];
}

export class MediaBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaBaseError';
  }
}

export function parseMediaBase(mediaBaseUrl: string): { origin: string; path: string } {
  let url: URL;
  try {
    url = new URL(mediaBaseUrl);
  } catch {
    throw new MediaBaseError('the tenant media base is not a URL');
  }
  if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '') {
    throw new MediaBaseError('the tenant media base must be https with no query or fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  // A base with no path is a whole shared host, not one tenant's prefix.
  if (path === '') throw new MediaBaseError('the tenant media base has no tenant prefix');
  return { origin: url.origin, path };
}

const URL_PATTERN = /https:\/\/[^\s"'<>()\\]+/g;

/**
 * Finds every media reference in the content export. URLs on other origins
 * are links, not tenant media, and are ignored.
 */
export function scanMediaReferences(contentJson: string, mediaBaseUrl: string): ReferenceScan {
  const base = parseMediaBase(mediaBaseUrl);
  const keys = new Set<string>();
  const refused = new Map<string, RefusedReference>();
  for (const match of contentJson.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(/[.,;:!]+$/, '');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;
    const bare = `${url.origin}${url.pathname}`;
    if (!url.pathname.startsWith(`${base.path}/`)) {
      refused.set(bare, { reference: bare, reason: 'outside-tenant-prefix' });
      continue;
    }
    let key: string;
    try {
      // A decoded slash would turn one path segment into two.
      if (/%2f|%5c/i.test(url.pathname)) throw new Error('encoded separator');
      key = url.pathname
        .slice(base.path.length + 1)
        .split('/')
        .map(decodeURIComponent)
        .join('/');
      assertSafeObjectKey(key);
    } catch {
      refused.set(bare, { reference: bare, reason: 'unsafe-key' });
      continue;
    }
    keys.add(key);
  }
  return { keys: [...keys].sort(), refused: [...refused.values()] };
}

export interface MediaProbeResult {
  readonly exists: boolean;
  readonly bytes: number | null;
}

/** Checks that one object really is there. Runs against the unsigned media address. */
export interface MediaProbe {
  head(url: string): Promise<MediaProbeResult>;
}

export interface MediaLinkEntry {
  readonly key: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly bytes: number | null;
}

export interface MediaPlan {
  readonly links: readonly MediaLinkEntry[];
  readonly missing: readonly string[];
  readonly unverified: readonly string[];
  readonly refused: readonly RefusedReference[];
}

const PROBE_CONCURRENCY = 8;

export function objectUrl(mediaBaseUrl: string, key: string): string {
  const base = parseMediaBase(mediaBaseUrl);
  return `${base.origin}${base.path}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Probes every referenced object and signs a link for each one that is
 * there. An object that is not there is `missing`; one the probe could not
 * answer for is `unverified`. Neither gets a link, and neither is silent.
 */
export async function planMedia(
  scan: ReferenceScan,
  mediaBaseUrl: string,
  probe: MediaProbe,
  signer: MediaLinkSigner,
  tenantId: string,
  nowSeconds: number
): Promise<MediaPlan> {
  const links: MediaLinkEntry[] = [];
  const missing: string[] = [];
  const unverified: string[] = [];
  const queue = [...scan.keys];
  async function worker(): Promise<void> {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      let result: MediaProbeResult;
      try {
        result = await probe.head(objectUrl(mediaBaseUrl, key));
      } catch {
        unverified.push(key);
        continue;
      }
      if (!result.exists) {
        missing.push(key);
        continue;
      }
      let signed;
      try {
        signed = signMediaLink(signer, tenantId, key, nowSeconds);
      } catch (err) {
        if (err instanceof MediaLinkError && err.reason === 'bad-key') {
          unverified.push(key);
          continue;
        }
        throw err;
      }
      links.push({ key, url: signed.url, expiresAt: signed.expiresAt, bytes: result.bytes });
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    links: links.sort((a, b) => byKey(a.key, b.key)),
    missing: missing.sort(byKey),
    unverified: unverified.sort(byKey),
    refused: scan.refused,
  };
}

/** The HTTP probe used outside tests: a HEAD against the public media address. */
export function createHttpMediaProbe(timeoutMs: number): MediaProbe {
  return {
    async head(url) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'manual',
        });
        if (response.status === 200) {
          const length = Number(response.headers.get('content-length'));
          return { exists: true, bytes: Number.isFinite(length) && length >= 0 ? length : null };
        }
        if (response.status === 404 || response.status === 403)
          return { exists: false, bytes: null };
        throw new Error(`media probe answered ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
