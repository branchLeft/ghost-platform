// A small HTTP client for the suite's own calls (Ghost's admin API, page
// fetches for hash derivation). Node does not resolve `*.localhost` on every
// platform, though a browser always does, so a name ending `.localhost` is
// pinned to the loopback address here and only here. Any other name resolves
// normally.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

export interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
  readonly setCookies: readonly string[];
}

export interface HttpInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const loopbackLookup: LookupFunction = (hostname, options, callback) => {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (options.all === true) {
      (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: '127.0.0.1', family: 4 },
      ]);
    } else {
      callback(null, '127.0.0.1', 4);
    }
    return;
  }
  void import('node:dns').then(({ lookup }) => {
    lookup(hostname, options, callback as never);
  });
};

export function http(url: string, init: HttpInit = {}): Promise<HttpResult> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = init.body === undefined ? undefined : Buffer.from(init.body);
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: init.method ?? 'GET',
        lookup: loopbackLookup,
        headers: {
          ...(body === undefined ? {} : { 'content-length': String(body.length) }),
          ...(init.headers ?? {}),
        },
        timeout: init.timeoutMs ?? 30_000,
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            setCookies: res.headers['set-cookie'] ?? [],
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error(`no response from ${target.host} in time`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The shape `deriveThemeCsp` expects of `fetch`: `ok`, `status` and `text()`. */
export function fetchLike(
  url: URL | string,
  init: { signal?: AbortSignal } = {}
): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  return http(String(url), init.signal === undefined ? {} : { signal: init.signal }).then((r) => ({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    text: () => Promise.resolve(r.body.toString('utf-8')),
  }));
}
