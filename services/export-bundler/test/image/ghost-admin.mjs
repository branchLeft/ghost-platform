import crypto from 'node:crypto';

const ADMIN = '/ghost/api/admin';

function ok(res, what, expected = [200, 201]) {
  if (!expected.includes(res.status)) {
    throw new Error(`${what} answered ${res.status}: ${res.text.slice(0, 500)}`);
  }
  return res;
}

function multipart(fieldName, filename, contentType, content, fields = {}) {
  const boundary = `----exportreimport${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** An owner session on one GhostContainer, using Ghost's own admin routes only. */
export class GhostAdmin {
  constructor(container) {
    this.container = container;
    this.cookie = undefined;
  }

  async setupOwner({ email, password, name = 'OWNER_NAME', siteTitle = 'SITE_TITLE' }) {
    ok(
      await this.container.request('POST', `${ADMIN}/authentication/setup/`, {
        setup: [{ name, email, password, blogTitle: siteTitle }],
      }),
      'owner setup'
    );
    const session = ok(
      await this.container.request('POST', `${ADMIN}/session/`, { username: email, password }),
      'owner sign-in'
    );
    this.cookie = session.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  }

  call(method, path, body, headers = {}) {
    return this.container.request(method, `${ADMIN}${path}`, body, {
      cookie: this.cookie,
      ...headers,
    });
  }

  async json(path) {
    return JSON.parse(ok(await this.call('GET', path), `GET ${path}`).text);
  }

  async createTag(tag) {
    ok(await this.call('POST', '/tags/', { tags: [tag] }), `create tag ${tag.slug}`);
  }

  async createPost(post) {
    ok(
      await this.call('POST', '/posts/?source=html', {
        posts: [{ status: 'published', ...post }],
      }),
      `create post ${post.slug}`
    );
  }

  async createMember(member) {
    ok(
      await this.call('POST', '/members/', { members: [member] }),
      `create member ${member.email}`
    );
  }

  async setSettings(entries) {
    ok(
      await this.call('PUT', '/settings/', {
        settings: Object.entries(entries).map(([key, value]) => ({ key, value })),
      }),
      'update settings'
    );
  }

  /** Ghost's own "Content & settings" export: the raw JSON bytes. */
  async exportContent() {
    return ok(await this.call('GET', '/db/'), 'export content and settings').body;
  }

  /** Ghost's own import of that same file into this instance. */
  async importContent(bytes) {
    const form = multipart('importfile', 'export.json', 'application/json', bytes);
    return ok(
      await this.call('POST', '/db/', form.body, { 'content-type': form.contentType }),
      'import content and settings'
    );
  }

  /** Ghost's own members CSV export: the raw bytes. */
  async exportMembersCsv() {
    return ok(await this.call('GET', '/members/upload/?limit=all'), 'export members').body;
  }

  /** Ghost's own members CSV import into this instance. */
  async importMembersCsv(bytes) {
    const form = multipart('membersfile', 'members.csv', 'text/csv', bytes, {
      'mapping[email]': 'email',
      'mapping[name]': 'name',
      'mapping[note]': 'note',
      'mapping[labels]': 'labels',
      'mapping[subscribed]': 'subscribed_to_emails',
    });
    return ok(
      await this.call('POST', '/members/upload/', form.body, { 'content-type': form.contentType }),
      'import members'
    );
  }

  async listPosts() {
    return (await this.json('/posts/?limit=all&fields=slug,title,status&formats=html&include=tags'))
      .posts;
  }

  async listTags() {
    return (await this.json('/tags/?limit=all')).tags;
  }

  async listMembers() {
    return (await this.json('/members/?limit=all&include=labels')).members;
  }

  async settingsMap() {
    const { settings } = await this.json('/settings/');
    return Object.fromEntries(settings.map((s) => [s.key, s.value]));
  }
}
