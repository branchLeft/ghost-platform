#!/usr/bin/env node
// Takes a fresh Ghost container through its owner-setup wizard and creates
// one published, tagged post -- the same reason widgets/proof/capture-
// network.mjs's own setupContent() does this: a compiled-default install
// serves only the "Coming Soon" placeholder, which has no post, tag or
// author page for derive-script-hashes.mjs to render at all. Prints three
// `KEY=value` lines to stdout (`POST_SLUG=`, `TAG_SLUG=`, `AUTHOR_SLUG=`)
// -- shell-`eval`-able by run-proof.sh, rather than JSON a shell script
// would need a second interpreter to parse.
const ORIGIN = process.env.PROOF_ORIGIN || 'http://localhost:4310';
const SETUP_NAME = 'Proof Admin';
const SETUP_EMAIL = 'csp-proof-admin@example.test';
const SETUP_PASSWORD = 'CspProof123!';

async function call(path, options = {}, cookie) {
  const headers = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    ...(options.headers || {}),
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(ORIGIN + path, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable body>');
    throw new Error(`${options.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return res;
}

async function main() {
  await call('/ghost/api/admin/authentication/setup/', {
    method: 'POST',
    body: JSON.stringify({
      setup: [
        { name: SETUP_NAME, email: SETUP_EMAIL, password: SETUP_PASSWORD, blogTitle: 'CSP Proof' },
      ],
    }),
  });

  const sessionRes = await call('/ghost/api/admin/session/', {
    method: 'POST',
    body: JSON.stringify({ username: SETUP_EMAIL, password: SETUP_PASSWORD }),
  });
  const setCookie = sessionRes.headers.get('set-cookie');
  if (!setCookie) throw new Error('session: no Set-Cookie header returned');
  const cookie = setCookie.split(';')[0];

  const postRes = await call(
    '/ghost/api/admin/posts/?source=html&include=authors,tags',
    {
      method: 'POST',
      body: JSON.stringify({
        posts: [
          {
            title: 'CSP proof post',
            html: '<p>Content for the strict-content-policy live proof.</p>',
            status: 'published',
            tags: [{ name: 'CSP Proof Tag' }],
          },
        ],
      }),
    },
    cookie
  );
  const postBody = await postRes.json();
  const post = postBody?.posts?.[0];
  const postSlug = post?.slug;
  const tagSlug = post?.tags?.[0]?.slug;
  const authorSlug = post?.authors?.[0]?.slug;
  if (!postSlug || !tagSlug || !authorSlug) {
    throw new Error(
      `setup: missing slug(s) in response: ${JSON.stringify(postBody).slice(0, 400)}`
    );
  }

  console.log(`POST_SLUG=${postSlug}`);
  console.log(`TAG_SLUG=${tagSlug}`);
  console.log(`AUTHOR_SLUG=${authorSlug}`);
  // Handed to inject-attack.mjs so it reuses this session rather than
  // logging in a second time -- a second login from a fresh process trips
  // Ghost's own new-sign-in notification email, which 500s with no mail
  // transport configured (measured running this proof; not a CSP concern
  // at all, just an artefact of two separate script invocations).
  console.log(`SESSION_COOKIE="${cookie}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
