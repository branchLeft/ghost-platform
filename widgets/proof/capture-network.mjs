#!/usr/bin/env node
// Runs Ghost's own owner-setup wizard against a fresh container (an
// announcement, a published post of our own), then drives a real headless
// Chromium against the origin container (Caddy in front of the pinned
// Ghost image), recording every network request the browser makes while
// exercising the home page with the admin-toolbar marker cookie set,
// Portal's sign-in overlay, search, the published post (comments), and a
// signup-form embed built from Ghost's own live config. Portal and
// sodoSearch render unconditionally, in ghost_head.js, on any install; the
// other four do not -- announcementBar needs a configured announcement,
// comments needs a post whose comment_id context the theme's helper
// receives, adminToolbar needs the marker cookie, and signupForm is never
// requested by a Ghost-rendered page at all (it is meant to be pasted onto
// an external page, so this proof builds that page itself). A proof that
// skipped setup could never have caught a broken override for any of the
// first three.
//
// Fails (exit 1) if any pinned bundle is never requested at all -- the
// primary signal, independent of where a fallback lands -- or if any
// script/stylesheet request's origin is not the origin under test, the
// resource types CSP's script-src/style-src govern and the only ones a
// Ghost config-key override can redirect. Every third-party request of any
// type is still recorded in the output, scored or not. A setup step that
// fails (Admin API rejects the request, no session cookie, no post slug) is
// fatal (exit 2) -- swallowing it here would silently narrow the proof to
// whichever bundles happen to render without any content at all.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.PROOF_ORIGIN || 'http://localhost:4300';
const LABEL = process.env.PROOF_LABEL || 'run';

const originUrl = new URL(ORIGIN);

// The CSP directive this story closes is script-src (LLD-5 C2; the issue's
// own priority comment: "the strict CSP needs zero third-party script
// origins") -- so the pass/fail signal is scoped to the resource types that
// directive governs: script and stylesheet, exactly the two Ghost config
// keys pins.json overrides. img-src is a different, much more permissive
// directive that this story's mechanism (a fixed set of config-key URLs)
// cannot address -- see widgets/README.md for what it actually covers.
// Every third-party request is still recorded in `allThirdParty` below
// regardless of type, so nothing is hidden -- only the exit code is scoped
// to what pinning can actually fix. Bundle *absence* (missingBundles,
// below) is a separate, type-independent signal and is not scoped at all.
const SCOPED_TYPES = new Set(['script', 'stylesheet']);

function isThirdPartyOrigin(requestUrl) {
  let u;
  try {
    u = new URL(requestUrl);
  } catch {
    return false; // data:, blob:, about: etc -- never a network origin
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') {
    return false;
  }
  return u.origin !== originUrl.origin;
}

// Throwaway credentials for a throwaway, per-run sqlite database inside a
// container this proof also tears down -- never a real install, never
// reused.
const SETUP_NAME = 'Proof Admin';
const SETUP_EMAIL = 'proof-admin@example.test';
const SETUP_PASSWORD = 'WidgetsProof123!';

async function setupContent(origin) {
  async function call(path, options = {}, cookie) {
    const headers = {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(options.headers || {}),
    };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(origin + path, { ...options, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(
        `setup: ${options.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 300)}`
      );
    }
    return res;
  }

  // 1. Owner setup -- an unconfigured Ghost serves nothing but the
  // "Coming Soon" placeholder until this runs.
  await call('/ghost/api/admin/authentication/setup/', {
    method: 'POST',
    body: JSON.stringify({
      setup: [
        {
          name: SETUP_NAME,
          email: SETUP_EMAIL,
          password: SETUP_PASSWORD,
          blogTitle: 'Widgets Proof',
        },
      ],
    }),
  });

  // 2. A session cookie -- every call below needs it.
  const sessionRes = await call('/ghost/api/admin/session/', {
    method: 'POST',
    body: JSON.stringify({ username: SETUP_EMAIL, password: SETUP_PASSWORD }),
  });
  const setCookie = sessionRes.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('setup: /ghost/api/admin/session/ returned 201 but no Set-Cookie header');
  }
  const cookie = setCookie.split(';')[0];

  // 3. The announcement bar -- off by default (announcement_content is
  // empty), so announcementBar.min.js is never requested without this.
  await call(
    '/ghost/api/admin/settings/',
    {
      method: 'PUT',
      body: JSON.stringify({
        settings: [
          { key: 'announcement_content', value: 'Widgets proof announcement' },
          { key: 'announcement_visibility', value: JSON.stringify(['visitors', 'free_members']) },
        ],
      }),
    },
    cookie
  );

  // 4. A real published post -- comments-ui.min.js is only rendered inside
  // a post's own comment_id context. The compiled-default install does
  // ship one published post (forks/Ghost's fixtures.json: slug
  // "coming-soon"), but its slug is a Ghost-core detail this proof
  // shouldn't have to know or depend on staying the same across versions --
  // creating our own, named for this proof, is what makes the slug used
  // below an asserted fact rather than an assumption.
  const postRes = await call(
    '/ghost/api/admin/posts/?source=html',
    {
      method: 'POST',
      body: JSON.stringify({
        posts: [
          {
            title: 'Widgets proof post',
            html: '<p>Content for the widgets live proof.</p>',
            status: 'published',
          },
        ],
      }),
    },
    cookie
  );
  const postBody = await postRes.json();
  const postSlug = postBody?.posts?.[0]?.slug;
  if (!postSlug) {
    throw new Error(
      `setup: post creation returned no slug: ${JSON.stringify(postBody).slice(0, 300)}`
    );
  }

  // 5. The live-resolved signupForm URL -- the same value Ghost Admin's own
  // "Growth > Embeddable signup form" tab reads to build its copy-paste
  // snippet (server/services/public-config/config.js exposes it here).
  // signup-form is the one bundle no Ghost-rendered page ever requests on
  // its own (see widgets/README.md); asking Ghost what it currently
  // resolves to, rather than hardcoding our own origin's path, is what
  // makes sabotaging signupForm__url provable -- a static embed page always
  // pointed at our own path would request it unchanged even with the
  // override removed.
  const configRes = await call('/ghost/api/admin/config/', {}, cookie);
  const configBody = await configRes.json();
  const signupFormUrl = configBody?.config?.signupForm?.url;
  if (!signupFormUrl) {
    throw new Error(
      `setup: /ghost/api/admin/config/ returned no config.signupForm.url: ${JSON.stringify(configBody).slice(0, 300)}`
    );
  }

  return { postSlug, signupFormUrl };
}

async function main() {
  // Fatal by construction: nothing below catches this. A broken setup step
  // must stop the run, not silently narrow which bundles get exercised.
  const { postSlug, signupFormUrl } = await setupContent(ORIGIN);

  const pinsManifest = JSON.parse(await readFile(join(__dirname, '..', 'pins.json'), 'utf8'));
  const pinnedPaths = pinsManifest.bundles.map((b) => new URL(b.servedPath, ORIGIN).toString());

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const allRequests = [];
  const thirdParty = []; // scoped: script/stylesheet only -- one pass/fail signal
  const allThirdParty = []; // every third-party request, any resource type -- never hidden

  context.on('request', (req) => {
    allRequests.push(req.url());
    if (!isThirdPartyOrigin(req.url())) return;
    allThirdParty.push({ url: req.url(), resourceType: req.resourceType() });
    if (SCOPED_TYPES.has(req.resourceType())) {
      thirdParty.push(req.url());
    }
  });

  const steps = [];

  // 0. The admin-toolbar marker cookie -- the same mechanism Ghost Admin's
  // own "View site" link uses (frontend/web/middleware/admin-toolbar.js):
  // a visit carrying ?admin=1 sets a signed cookie and 302s to the clean
  // URL, and the redirected response already carries admin-toolbar.min.js
  // (verified directly against this image before writing this). No admin
  // session needed in the browser at all -- this is a front-end-only
  // marker, not an authenticated view.
  await page.goto(ORIGIN + '/?admin=1', { waitUntil: 'networkidle', timeout: 30000 });
  steps.push('admin-toolbar marker cookie set');

  // 1. Home page -- now a real site, not the compiled-default "Coming Soon"
  // placeholder.
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle', timeout: 30000 });
  steps.push('home page loaded');

  // 2. Portal sign-in overlay -- Portal mounts a trigger button; open the
  // sign-in flow via its documented URL hash rather than hunting for a
  // selector in whatever theme is active.
  await page.goto(ORIGIN + '/#/portal/signin', { waitUntil: 'networkidle', timeout: 30000 });
  // Portal renders inside an iframe; wait for it rather than a fixed sleep.
  try {
    await page.waitForSelector(
      'iframe[title="portal-popup"], iframe.gh-portal-popup-iframe, iframe[src*="portal"]',
      { timeout: 10000 }
    );
    steps.push('portal sign-in overlay rendered');
  } catch {
    steps.push(
      'portal sign-in overlay: no matching iframe found (recorded, not fatal to the network assertion)'
    );
  }
  await page.waitForTimeout(1000); // let Portal's own deferred requests land

  // 3. Search -- sodoSearch mounts a root element unconditionally, but
  // renders nothing into it, and never fetches its stylesheet, until the
  // theme's own trigger button is actually activated. The theme's search
  // button is conditionally hidden by CSS depending on viewport/nav state,
  // so this clicks it via the DOM directly rather than through Playwright's
  // visibility-gated pointer click, which timed out waiting for it to
  // become visible during development of this proof.
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle', timeout: 30000 });
  const searchClicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-ghost-search]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!searchClicked) {
    throw new Error('search: no [data-ghost-search] trigger button found on the home page');
  }
  await page.waitForTimeout(1500);
  steps.push('search widget opened');

  // 4. The real published post this run's own setup created -- comments-ui
  // is only ever requested inside a post's comment_id context.
  await page.goto(`${ORIGIN}/${postSlug}/`, { waitUntil: 'networkidle', timeout: 30000 });
  steps.push(`post page loaded (${postSlug})`);
  await page.waitForTimeout(1000);

  // 5. The signup-form embed -- built from the URL Ghost's own admin config
  // endpoint resolves right now for this pass (our origin normally, the
  // compiled CDN default when signupForm__url is sabotaged), the same
  // mechanism a real embeddable-snippet feature reads. Page content is set
  // directly rather than served from a static file: the src has to vary
  // per pass for the sabotage loop to mean anything.
  await page.setContent(
    `<!doctype html><html><body><div style="min-height: 400px"><script src="${signupFormUrl}" data-button-color="#ff0095" data-label-1="Signup form" data-label-2="Self-hosted proof" async></script></div></body></html>`,
    { waitUntil: 'networkidle' }
  );
  await page.waitForTimeout(1000);
  steps.push('signup-form embed rendered');

  await browser.close();

  // The primary signal: every pinned bundle must have been requested at
  // all, independent of where a fallback would have landed. This is what
  // an unconfigured install's "Coming Soon" placeholder could never have
  // passed by accident -- comments-ui, announcement-bar and admin-toolbar
  // are absent from that page entirely, not merely third-party.
  const requestedSet = new Set(allRequests);
  const missingBundles = pinnedPaths.filter((p) => !requestedSet.has(p));

  const uniqueAllThirdParty = [...new Map(allThirdParty.map((r) => [r.url, r])).values()];

  const result = {
    label: LABEL,
    origin: originUrl.origin,
    steps,
    totalRequests: allRequests.length,
    // Every pinned bundle's served path that this run never requested at
    // all -- the primary sabotage signal, type- and origin-independent.
    missingBundles,
    // The pass/fail signal: third-party script or stylesheet requests, the
    // resource types CSP's script-src/style-src govern and the only ones
    // pins.json's config-key overrides can address.
    thirdPartyRequests: [...new Set(thirdParty)],
    // Every third-party request of any type, scoped ones included -- so a
    // non-empty list here that isn't reflected above is a recorded,
    // visible fact, not a hidden one. Non-empty on every pass in this
    // story's proof: two static.ghost.org image URLs, both Ghost-core
    // seed data rather than anything this proof's own setup wrote --
    // default-settings.json's site-wide cover_image, and the compiled
    // "coming-soon" fixture post's own feature_image (fixtures.json).
    // Neither is a widget bundle, and neither is addressable by a
    // config-key pin -- see widgets/README.md.
    allThirdPartyRequests: uniqueAllThirdParty,
  };

  console.log(JSON.stringify(result, null, 2));

  const failed = result.missingBundles.length > 0 || result.thirdPartyRequests.length > 0;

  if (result.missingBundles.length > 0) {
    console.error(
      `\n[${LABEL}] RED: ${result.missingBundles.length} pinned bundle(s) never requested: ${result.missingBundles.join(', ')}`
    );
  }
  if (result.thirdPartyRequests.length > 0) {
    console.error(
      `[${LABEL}] RED: ${result.thirdPartyRequests.length} third-party script/stylesheet origin(s) requested: ${result.thirdPartyRequests.join(', ')}`
    );
  }

  if (failed) {
    process.exit(1);
  }

  console.error(
    `\n[${LABEL}] GREEN: ${result.totalRequests} requests captured, all ${pinnedPaths.length} pinned bundles requested, zero third-party script/stylesheet origins` +
      (uniqueAllThirdParty.length > 0
        ? ` (${uniqueAllThirdParty.length} other-type third-party request(s) recorded above, not scored).`
        : '.')
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
