/** A relative object key: no empty, dot or encoded-dot segments, no backslash, no control byte. */
export function assertSafeObjectKey(key: string): void {
  const segments = key.split('/');
  const bad =
    key.length === 0 ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f?#]/.test(key) ||
    segments.some((seg) => seg === '' || seg === '.' || seg === '..' || /^(%2e)+$/i.test(seg)) ||
    /%2f|%5c/i.test(key);
  if (bad) throw new MediaBaseError(`unsafe media object key: ${JSON.stringify(key)}`);
}

export class ErasureDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErasureDateError';
  }
}

/** The date after which the tenant's public media addresses stop working: a real, future calendar day. */
export function parseErasureDate(value: string, nowSeconds: number): string {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new ErasureDateError('the erasure date is not a calendar date (YYYY-MM-DD)');
  }
  if (ms <= nowSeconds * 1000) throw new ErasureDateError('the erasure date is not in the future');
  return value;
}

/**
 * The media half of the export: links, never bytes. A tenant holds no
 * storage key, so a bucket-to-bucket copy cannot exist. A reference is
 * linked only if it lies under the tenant's own scope (media address plus
 * its Ghost tenant prefix); anything else on the shared shard is refused.
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

/** Checks that one object really is there. Runs against the public media address. */
export interface MediaProbe {
  head(url: string): Promise<MediaProbeResult>;
}

export interface MediaAddress {
  readonly key: string;
  /** The ordinary public address, the one the tenant's own site serves the file from. */
  readonly url: string;
  readonly bytes: number | null;
}

export interface MediaPlan {
  readonly addresses: readonly MediaAddress[];
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
 * Probes every referenced object and lists the public address of each one
 * that is there. An object that is not there is `missing`; one the probe
 * could not answer for is `unverified`. Neither is listed, and neither is
 * silent.
 */
export async function planMedia(
  scan: ReferenceScan,
  mediaBaseUrl: string,
  probe: MediaProbe
): Promise<MediaPlan> {
  const addresses: MediaAddress[] = [];
  const missing: string[] = [];
  const unverified: string[] = [];
  const queue = [...scan.keys];
  async function worker(): Promise<void> {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      const url = objectUrl(mediaBaseUrl, key);
      let result: MediaProbeResult;
      try {
        result = await probe.head(url);
      } catch {
        unverified.push(key);
        continue;
      }
      if (result.exists) addresses.push({ key, url, bytes: result.bytes });
      else missing.push(key);
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    addresses: addresses.sort((a, b) => byKey(a.key, b.key)),
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
