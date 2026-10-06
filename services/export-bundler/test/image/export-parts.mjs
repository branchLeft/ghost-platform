// The named items an export must carry, one part per kind of export, so
// assertions name items rather than counting or checking status codes.
// Rationale and how to add a part: export-reimport.image.test.md.

export const NAMED_POSTS = [
  {
    slug: 'named-post-published',
    title: 'NAMED_POST_PUBLISHED',
    status: 'published',
    body: 'NAMED_BODY_PUBLISHED',
    tag: 'named-tag-alpha',
  },
  {
    slug: 'named-post-draft',
    title: 'NAMED_POST_DRAFT',
    status: 'draft',
    body: 'NAMED_BODY_DRAFT',
    tag: 'named-tag-beta',
  },
];

export const NAMED_TAGS = [
  { slug: 'named-tag-alpha', name: 'NAMED_TAG_ALPHA', description: 'NAMED_TAG_ALPHA_DESCRIPTION' },
  { slug: 'named-tag-beta', name: 'NAMED_TAG_BETA', description: 'NAMED_TAG_BETA_DESCRIPTION' },
];

export const NAMED_MEMBERS = [
  {
    email: 'named-member-one@example.test',
    name: 'NAMED_MEMBER_ONE',
    note: 'NAMED_NOTE_ONE',
    label: 'NAMED_LABEL_ONE',
  },
  {
    email: 'named-member-two@example.test',
    name: 'NAMED_MEMBER_TWO',
    note: 'NAMED_NOTE_TWO',
    label: 'NAMED_LABEL_TWO',
  },
];

export const NAMED_SETTINGS = {
  title: 'NAMED_SITE_TITLE',
  description: 'NAMED_SITE_DESCRIPTION',
};

function check(failures, ok, message) {
  if (!ok) failures.push(message);
}

/** Posts, tags and settings: Ghost's own "Content & settings" JSON. */
export const contentPart = {
  name: 'content',

  async seed(admin) {
    for (const tag of NAMED_TAGS) await admin.createTag(tag);
    for (const post of NAMED_POSTS) {
      await admin.createPost({
        slug: post.slug,
        title: post.title,
        status: post.status,
        html: `<p>${post.body}</p>`,
        tags: [{ slug: post.tag }],
      });
    }
    await admin.setSettings(NAMED_SETTINGS);
  },

  exportFrom: (admin) => admin.exportContent(),
  importInto: (admin, bytes) => admin.importContent(bytes),

  async verify(admin) {
    const failures = [];
    const posts = await admin.listPosts();
    for (const named of NAMED_POSTS) {
      const found = posts.find((p) => p.slug === named.slug);
      check(failures, found, `post ${named.slug} is missing`);
      if (!found) continue;
      check(
        failures,
        found.title === named.title,
        `post ${named.slug} has title ${found.title}, not ${named.title}`
      );
      check(
        failures,
        found.status === named.status,
        `post ${named.slug} is ${found.status}, not ${named.status}`
      );
      check(
        failures,
        (found.html ?? '').includes(named.body),
        `post ${named.slug} lost its body ${named.body}`
      );
      check(
        failures,
        (found.tags ?? []).some((t) => t.slug === named.tag),
        `post ${named.slug} is no longer tagged ${named.tag}`
      );
    }
    const tags = await admin.listTags();
    for (const named of NAMED_TAGS) {
      const found = tags.find((t) => t.slug === named.slug);
      check(failures, found, `tag ${named.slug} is missing`);
      if (!found) continue;
      check(
        failures,
        found.name === named.name,
        `tag ${named.slug} has name ${found.name}, not ${named.name}`
      );
      check(
        failures,
        found.description === named.description,
        `tag ${named.slug} lost its description`
      );
    }
    const settings = await admin.settingsMap();
    for (const [key, value] of Object.entries(NAMED_SETTINGS)) {
      check(
        failures,
        settings[key] === value,
        `setting ${key} is ${JSON.stringify(settings[key])}, not ${JSON.stringify(value)}`
      );
    }
    return failures;
  },
};

/** Members: Ghost's own members CSV, which the JSON export does not carry. */
export const membersPart = {
  name: 'members',

  async seed(admin) {
    for (const m of NAMED_MEMBERS) {
      await admin.createMember({
        email: m.email,
        name: m.name,
        note: m.note,
        labels: [{ name: m.label }],
      });
    }
  },

  exportFrom: (admin) => admin.exportMembersCsv(),
  importInto: (admin, bytes) => admin.importMembersCsv(bytes),

  async verify(admin) {
    const failures = [];
    const members = await admin.listMembers();
    for (const named of NAMED_MEMBERS) {
      const found = members.find((m) => m.email === named.email);
      check(failures, found, `member ${named.email} is missing`);
      if (!found) continue;
      check(
        failures,
        found.name === named.name,
        `member ${named.email} has name ${found.name}, not ${named.name}`
      );
      check(failures, found.note === named.note, `member ${named.email} lost its note`);
      check(
        failures,
        (found.labels ?? []).some((l) => l.name === named.label),
        `member ${named.email} lost label ${named.label}`
      );
    }
    return failures;
  },
};

export const PARTS = [contentPart, membersPart];

/** Every failure across `parts`, each prefixed with its part; empty means every named item survived. */
export async function verifyNamedItems(admin, parts = PARTS) {
  const failures = [];
  for (const part of parts) {
    for (const failure of await part.verify(admin)) failures.push(`${part.name}: ${failure}`);
  }
  return failures;
}

/** Take each part's export from `source`, as bytes keyed by part name. */
export async function exportParts(source, parts = PARTS) {
  const out = {};
  for (const part of parts) out[part.name] = await part.exportFrom(source);
  return out;
}

/** Put each part's export into `target`. */
export async function importParts(target, exported, parts = PARTS) {
  for (const part of parts) await part.importInto(target, exported[part.name]);
}

/** The Content & settings JSON with one post removed: a deliberately lossy export. */
export function dropPostFromContent(bytes, slug) {
  const json = JSON.parse(bytes.toString('utf8'));
  const data = json.db[0].data;
  const dropped = data.posts.filter((p) => p.slug === slug).map((p) => p.id);
  if (dropped.length === 0) throw new Error(`the export holds no post ${slug} to drop`);
  data.posts = data.posts.filter((p) => !dropped.includes(p.id));
  for (const key of ['posts_tags', 'posts_authors', 'posts_meta']) {
    if (!data[key]) continue;
    data[key] = data[key].filter((row) => !dropped.includes(row.post_id));
  }
  return Buffer.from(JSON.stringify(json));
}
