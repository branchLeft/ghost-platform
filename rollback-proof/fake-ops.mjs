// A small in-memory world for the proof's tests: images that migrate a shared
// schema when they boot, and an admin surface over shared posts and members.
// An image is `{ schema, inDevelopment?, neverCreated?, migrate?(tables), bootError?(tables), onBoot?(world), fault? }`
// where `fault` names a smoke step that image breaks on.

/** Ghost-shaped schema JSON to the rows the information schema would give. */
export function rowsFromTables(tables) {
  const rows = [];
  for (const [table, columns] of Object.entries(tables)) {
    for (const [column, spec] of Object.entries(columns)) {
      rows.push({
        table,
        column,
        nullable: spec.nullable !== false,
        hasDefault: spec.defaultTo !== undefined,
        generated: false,
      });
    }
  }
  return rows;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

export function fakeWorld() {
  return {
    tables: undefined,
    posts: new Map(),
    members: new Set(),
    cookies: new Set(),
    events: [],
    cookieSeq: 0,
  };
}

export function fakeOps(images, { world = fakeWorld(), everythingRenders = false, failOpen } = {}) {
  const image = (ref) => {
    if (!Object.hasOwn(images, ref)) throw new Error(`no such image ${ref}`);
    return images[ref];
  };
  const newCookie = () => {
    world.cookieSeq += 1;
    const cookie = `session=${world.cookieSeq}`;
    world.cookies.add(cookie);
    return cookie;
  };

  const makeColour = (ref, label) => {
    const spec = image(ref);
    // A fault bites only on the way back, so the seed and the new image are unaffected.
    const faultsAt = (step) => spec.fault === step && label === 'old-after';
    const admin = (cookie) => ({
      async createPost(post) {
        if (!world.cookies.has(cookie)) throw new Error('not signed in');
        if (faultsAt('publish')) throw new Error('publish answered 500');
        world.posts.set(post.slug, post.html);
      },
      async createMember(member) {
        if (faultsAt('member-create')) throw new Error('member creation answered 500');
        world.members.add(member.email);
      },
      async listPosts() {
        if (faultsAt('old-reads-data')) throw new Error('the post list answered 500');
        return [...world.posts.keys()].map((slug) => ({ slug }));
      },
      async me() {
        return world.cookies.has(cookie) ? 200 : 403;
      },
    });
    return {
      async setupOwner() {
        return newCookie();
      },
      async signIn() {
        if (faultsAt('sign-in')) throw new Error('owner sign-in answered 500');
        return newCookie();
      },
      admin,
      async page(path) {
        const slug = path.replaceAll('/', '');
        if (world.posts.has(slug)) return { status: 200, text: world.posts.get(slug) };
        return everythingRenders ? { status: 200, text: '' } : { status: 404, text: '' };
      },
      async remove() {
        world.events.push(`remove ${label}`);
      },
    };
  };

  return {
    world,
    async imageId(ref) {
      return `id:${image(ref).id ?? ref}`;
    },
    async readOldSchema(ref) {
      const spec = image(ref);
      return { tables: clone(spec.schema), inDevelopment: clone(spec.inDevelopment ?? []) };
    },
    async open() {
      if (failOpen) throw new Error(failOpen);
      world.events.push('open');
      return {
        async startColour(ref, label) {
          const spec = image(ref);
          if (world.tables === undefined) {
            // Like production: the tables the image lists as in development are never created.
            world.tables = clone(spec.schema);
            for (const table of spec.neverCreated ?? spec.inDevelopment ?? [])
              delete world.tables[table];
          } else {
            const reason = spec.bootError?.(world.tables);
            if (reason !== undefined) {
              world.events.push(`boot-failed ${label}`);
              throw new Error(reason);
            }
            if (spec.migrate) world.tables = spec.migrate(clone(world.tables));
          }
          spec.onBoot?.(world);
          world.events.push(`boot ${label} ${JSON.stringify(world.tables)}`);
          return makeColour(ref, label);
        },
        async readLiveColumns() {
          return rowsFromTables(world.tables);
        },
        async close() {
          world.events.push('close');
        },
      };
    },
  };
}
