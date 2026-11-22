// The slice of Ghost's admin API the attacks need: becoming the tenant's owner
// (the attacker on one tenant, the victim on the other), planting content, and
// reading the tenant's state back. One login per tenant, reused everywhere: a
// second sign-in from a new client makes Ghost send a notification mail, which
// fails where no mail transport is configured.

import { http, type HttpResult } from './http.ts';
import type { Credentials } from './target.ts';

export class GhostAdminError extends Error {}

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
}

export interface MultipartPart {
  readonly body: Buffer;
  readonly contentType: string;
}

/** Encodes one file field the way a browser's form would. */
export async function multipart(
  filename: string,
  bytes: Uint8Array,
  mime: string
): Promise<MultipartPart> {
  const form = new FormData();
  form.append('file', new Blob([bytes as BlobPart], { type: mime }), filename);
  const response = new Response(form);
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'multipart/form-data',
  };
}

export class GhostAdmin {
  readonly origin: string;
  private cookie: SessionCookie | null = null;

  constructor(origin: string) {
    this.origin = origin;
  }

  get session(): SessionCookie {
    if (this.cookie === null) throw new GhostAdminError(`not signed in to ${this.origin}`);
    return this.cookie;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      origin: this.origin,
      ...(this.cookie === null ? {} : { cookie: `${this.cookie.name}=${this.cookie.value}` }),
      ...extra,
    };
  }

  private async call(
    method: string,
    path: string,
    body?: Buffer | string,
    headers: Record<string, string> = {}
  ): Promise<HttpResult> {
    return http(`${this.origin}${path}`, {
      method,
      headers: this.headers(headers),
      ...(body === undefined ? {} : { body }),
    });
  }

  private async json(method: string, path: string, payload?: unknown): Promise<HttpResult> {
    return this.call(
      method,
      path,
      payload === undefined ? undefined : JSON.stringify(payload),
      payload === undefined ? {} : { 'content-type': 'application/json' }
    );
  }

  private ok(res: HttpResult, what: string): HttpResult {
    if (res.status < 200 || res.status >= 300) {
      throw new GhostAdminError(
        `${what}: ${res.status} ${res.body.toString('utf-8').slice(0, 200)}`
      );
    }
    return res;
  }

  async setupOwner(creds: Credentials, siteTitle: string): Promise<void> {
    this.ok(
      await this.json('POST', '/ghost/api/admin/authentication/setup/', {
        setup: [
          {
            name: 'Attack Suite',
            email: creds.email,
            password: creds.password,
            blogTitle: siteTitle,
          },
        ],
      }),
      'owner setup'
    );
  }

  async login(creds: Credentials): Promise<SessionCookie> {
    const res = this.ok(
      await this.json('POST', '/ghost/api/admin/session/', {
        username: creds.email,
        password: creds.password,
      }),
      'sign in'
    );
    const first = res.setCookies[0];
    if (first === undefined) throw new GhostAdminError('sign in: no session cookie was set');
    const pair = first.split(';')[0] ?? '';
    const at = pair.indexOf('=');
    this.cookie = { name: pair.slice(0, at), value: pair.slice(at + 1) };
    return this.cookie;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.ok(
      await this.json('PUT', '/ghost/api/admin/settings/', { settings: [{ key, value }] }),
      `set ${key}`
    );
  }

  /** Publishes a post whose body is one HTML card; returns its slug and id. */
  async publishHtmlPost(title: string, html: string): Promise<{ slug: string; id: string }> {
    const lexical = {
      root: {
        type: 'root',
        version: 1,
        direction: null,
        format: '',
        indent: 0,
        children: [{ type: 'html', version: 1, html }],
      },
    };
    const res = this.ok(
      await this.json('POST', '/ghost/api/admin/posts/', {
        posts: [{ title, lexical: JSON.stringify(lexical), status: 'published' }],
      }),
      `publish ${title}`
    );
    return postOf(res);
  }

  /** Publishes a plain post with a tag, the page the content policy's hashes are derived from. */
  async publishPlainPost(
    title: string
  ): Promise<{ slug: string; id: string; tag: string; author: string }> {
    const res = this.ok(
      await this.json('POST', '/ghost/api/admin/posts/?source=html&include=authors,tags', {
        posts: [
          {
            title,
            html: '<p>Content for the attack suite.</p>',
            status: 'published',
            tags: [{ name: 'Attack Suite Tag' }],
          },
        ],
      }),
      `publish ${title}`
    );
    const post = firstPost(res);
    const tag = post.tags?.[0]?.slug;
    const author = post.authors?.[0]?.slug;
    if (
      post.slug === undefined ||
      post.id === undefined ||
      tag === undefined ||
      author === undefined
    ) {
      throw new GhostAdminError('publish: the post came back without a slug, tag or author');
    }
    return { slug: post.slug, id: post.id, tag, author };
  }

  async uploadFile(
    filename: string,
    bytes: Uint8Array,
    mime: string
  ): Promise<{ status: number; url: string | null }> {
    const part = await multipart(filename, bytes, mime);
    const res = await this.call('POST', '/ghost/api/admin/files/upload/', part.body, {
      'content-type': part.contentType,
    });
    return { status: res.status, url: urlOf(res, 'files') };
  }

  async uploadTheme(
    filename: string,
    zip: Uint8Array
  ): Promise<{ status: number; name: string | null }> {
    const part = await multipart(filename, zip, 'application/zip');
    const res = await this.call('POST', '/ghost/api/admin/themes/upload/', part.body, {
      'content-type': part.contentType,
    });
    let name: string | null = null;
    try {
      const parsed = JSON.parse(res.body.toString('utf-8')) as { themes?: { name?: string }[] };
      name = parsed.themes?.[0]?.name ?? null;
    } catch {
      name = null;
    }
    return { status: res.status, name };
  }

  async activateTheme(name: string): Promise<number> {
    return (await this.json('PUT', `/ghost/api/admin/themes/${encodeURIComponent(name)}/activate/`))
      .status;
  }

  async countPosts(): Promise<number> {
    const res = this.ok(await this.json('GET', '/ghost/api/admin/posts/?limit=1'), 'count posts');
    const parsed = JSON.parse(res.body.toString('utf-8')) as {
      meta?: { pagination?: { total?: number } };
    };
    const total = parsed.meta?.pagination?.total;
    if (total === undefined) throw new GhostAdminError('count posts: no total in the response');
    return total;
  }
}

interface PostBody {
  slug?: string;
  id?: string;
  tags?: { slug?: string }[];
  authors?: { slug?: string }[];
}

function firstPost(res: HttpResult): PostBody {
  const parsed = JSON.parse(res.body.toString('utf-8')) as { posts?: PostBody[] };
  const post = parsed.posts?.[0];
  if (post === undefined) throw new GhostAdminError('no post in the response');
  return post;
}

function postOf(res: HttpResult): { slug: string; id: string } {
  const post = firstPost(res);
  if (post.slug === undefined || post.id === undefined) {
    throw new GhostAdminError('the post came back without a slug or id');
  }
  return { slug: post.slug, id: post.id };
}

function urlOf(res: HttpResult, field: 'files'): string | null {
  try {
    const parsed = JSON.parse(res.body.toString('utf-8')) as Record<string, { url?: string }[]>;
    return parsed[field]?.[0]?.url ?? null;
  } catch {
    return null;
  }
}
