# Self-hosted front-end widgets
The image built from the root `Dockerfile` loads six CDN script bundles plus
one CDN stylesheet by default, all on floating `~` version ranges. Ghost picks
each range from the `version` its own release carries in
`ghost/core/shared/config/defaults.json` (the path was `ghost/core/core/shared/...`
before 6.7x), so the pins are only valid for the Ghost release they were
resolved from; `pins.json` records it as `ghostVersion` and `sourceGhostImage`,
and `verify-pins.test.mjs` fails when either stops matching the Dockerfile's
`FROM` line. The keys: `portal`,
`sodoSearch` (script + `styles`), `announcementBar`, `comments`,
`adminToolbar`, `signupForm`. Each is a plain Ghost config key, overridable
by env var (nconf, `__` separator) with no Ghost source change.

**Where the pins live** (the issue's open question, decided here): this
directory. `pins.json` is the machine-readable manifest -- one row per
config key, each with its resolved CDN version, sha384 digest, byte count,
served path and env-var override name. `dist/` holds the vendored bytes
those digests describe. `scripts/fetch-pins.mjs` re-resolves and re-pins
from jsdelivr (a deliberate, reviewed commit, never run at build or deploy
time); `scripts/verify-pins.mjs` checks `dist/` still matches `pins.json`
and is what `verify-pins.test.mjs` runs as its (non-sabotage) assertion.

**Served from:** `origin/` -- a small Caddy image, pinned by digest like the
Ghost image itself, that serves `dist/` at `/bl-assets/*` and reverse-proxies
everything else to the Ghost container, so both are one origin to a reader's
browser. **Not** the estate's production edge -- that is LLD-5's own
component. This one exists so the
"zero third-party origins" claim can be proven against a real container
rather than asserted from config; a production edge is expected to fold `origin/Caddyfile`'s `file_server` block into its own
config rather than run this container permanently. `/bl-assets/` is the URL
path LLD-5 §06 marks incidental.

**Wired into the rendered Ghost environment, opt-in.** `render-core`'s
`tenantEnvironment()` renders the seven override keys as
`<siteUrl>/bl-assets/<file>` when asked for `widgets: 'own-origin'`
(`render()`'s `options.widgets`), and renders nothing by default: pointing a
tenant at a `/bl-assets/` path its edge does not serve would stop Portal and
search loading. `render-core/test/widgets.test.ts` fails when the renderer's
list and `pins.json` disagree. The edge that serves the path is
`branchLeft/shared-infra`'s `hetzner/edge`.

## Same-origin proof

`proof/same-origin.ts` is read-only and needs no setup, so it can be pointed
at a live site: it loads the named public pages in headless Chromium and fails
if any request leaves the site's origin (bar origins named in
`PROOF_ALLOW_ORIGINS`) or if `portal.min.js` and `sodo-search.min.js` are not
served 200 from `/bl-assets/`.

```
cd widgets/proof && pnpm install
PROOF_ORIGIN=https://site.example PROOF_PATHS=/,/some-post/ node same-origin.ts
```

Serving the bundles from the site does not stop what they call. Portal can
load `cdn.firstpromoter.com` (the `firstpromoter` setting) and fetch
`partner.transistor.fm` for a signed-in member (the Transistor integration);
Ghost has only those off-by-default tenant settings, which its host override
(`hostSettings__settingsOverrides__*`) can pin off. `own-origin` renders both
overrides unless `blockThirdPartyIntegrations` is `false`, which removes
FirstPromoter and Transistor for the tenant; with it `false`, a tenant that
turns one on fails this check by design. Portal's Sentry reporting is switched
off with `client_sentry__disabled=true` (see `render-core/src/environment.md`).

Checked locally against the Docker pair above with the seven keys set: exit 0;
with them removed: exit 1, naming the two jsDelivr requests. A fresh Ghost
install also requests two `static.ghost.org` images (see above), so a local run
sets `PROOF_ALLOW_ORIGINS=https://static.ghost.org`; a tenant's own media is on
its object-storage origin and needs that origin named the same way.

## The live proof

`proof/run-proof.sh` runs the whole thing against real Docker containers: a
GREEN baseline with every override set, then one RED (sabotage) pass per
pinned override -- each removes exactly one, proving that specific bundle's
pin is what closes it rather than only whichever one happens to be tested --
and a final GREEN restoring everything.

Each pass is driven by a real headless Chromium
(`proof/capture-network.mjs`, via Playwright), which first takes the
container through Ghost's own owner-setup wizard (an announcement, a
published post) before opening a browser: a fresh, unconfigured install
only ever requests `portal` and `sodoSearch` unconditionally --
`announcementBar`, `comments` and `adminToolbar` never render at all
without real content, and a proof that skipped setup could never have
caught a broken override for any of the three. It then exercises the home
page (with the admin-toolbar marker cookie set via `?admin=1`, the same
mechanism Ghost Admin's own "View site" link uses), Portal's sign-in
overlay, search (clicking the theme's own trigger button, since sodoSearch
mounts a root element but renders and fetches nothing until that fires),
the published post (comments), and a signup-form embed built from the URL
Ghost's admin config endpoint resolves right now for that pass -- the same
value a real embeddable-snippet feature reads, and the only way to make
sabotaging `signupForm__url` provable, since signup-form is never loaded by
a Ghost-rendered page at all (`proof/signup-embed.html` is kept as a
static, standalone reference for how a tenant would actually embed it by
hand; the automated proof builds its own page dynamically each pass).

Two independent, type-independent signals fail the run: any pinned bundle
that was never requested at all (`missingBundles` in the JSON output --
the primary signal, and what catches setup never having reached a real
post), or any third-party script/stylesheet request (`thirdPartyRequests`
-- the resource types CSP's script-src/style-src actually govern). Every
third-party request of any type is recorded regardless
(`allThirdPartyRequests`), scored or not -- currently always two
`static.ghost.org` image URLs, Ghost-core's own compiled defaults (the
`cover_image` setting and the seeded "coming-soon" post's `feature_image`),
unrelated to any widget bundle and not addressable by a config-key pin.

Run it from the repo root: `./widgets/proof/run-proof.sh` (needs Docker and
`widgets/proof`'s own `pnpm install` for Playwright -- kept out of the root
package.json and out of CI deliberately; see `proof/package.json`). Nine
container boots (one GREEN, seven RED, one GREEN), so it takes several
minutes.

## run-proof.sh

One GREEN baseline, then one RED pass per pinned override -- each removes
exactly one env-var override, proving that specific bundle's pin is what
closes it, not merely that the mechanism works for whichever one happens
to get sabotaged -- then a final GREEN restores everything:

- `GREEN-1` -- every widget config key pointed at our origin
- `RED-<override>` -- one override removed, so Ghost (or, for
  `signupForm`, the config Ghost reports) falls back to its compiled
  default (the jsdelivr CDN) -- proves the assertion actually fails when
  that one control is absent
- `GREEN-2` -- every override restored, proving the fix is what closed it

## capture-network setup and signal

Runs Ghost's own owner-setup wizard against a fresh container (an
announcement, a published post of our own), then drives a real headless
Chromium against the origin container (Caddy in front of the pinned Ghost
image), recording every network request the browser makes while exercising
the home page with the admin-toolbar marker cookie set, Portal's sign-in
overlay, search, the published post (comments), and a signup-form embed
built from Ghost's own live config. Portal and sodoSearch render
unconditionally, in `ghost_head.js`, on any install; the other four do not
-- `announcementBar` needs a configured announcement, `comments` needs a
post whose `comment_id` context the theme's helper receives,
`adminToolbar` needs the marker cookie, and `signupForm` is never
requested by a Ghost-rendered page at all (it is meant to be pasted onto
an external page, so this proof builds that page itself). A proof that
skipped setup could never have caught a broken override for any of the
first three.

Fails (exit 1) if any pinned bundle is never requested at all -- the
primary signal, independent of where a fallback lands -- or if any
script/stylesheet request's origin is not the origin under test, the
resource types CSP's script-src/style-src govern and the only ones a
Ghost config-key override can redirect. Every third-party request of any
type is still recorded in the output, scored or not. A setup step that
fails (Admin API rejects the request, no session cookie, no post slug) is
fatal (exit 2) -- swallowing it here would silently narrow the proof to
whichever bundles happen to render without any content at all.

## capture-network CSP scope

The CSP directive this closes is script-src (LLD-5 C2), so the pass/fail
signal is scoped to the resource types that directive governs: script and
stylesheet, exactly the two Ghost config keys `pins.json` overrides.
img-src is a different, much more permissive directive that a fixed set of
config-key URLs cannot address -- see above for what it actually covers.
Every third-party request is still recorded in `allThirdParty` regardless
of type, so nothing is hidden -- only the exit code is scoped to what
pinning can actually fix. Bundle *absence* (`missingBundles`) is a
separate, type-independent signal and is not scoped at all.

## fetch-pins.mjs

Reads the Ghost version from the root `Dockerfile`, fetches that release's
`defaults.json` from the public Ghost repository at its tag, takes each
widget's floating `~` range from it, downloads the exact bytes jsdelivr
currently resolves each range to, and writes them into `widgets/dist/`
alongside a content-digest manifest in `widgets/pins.json`. Bumping the
Ghost base image in the Dockerfile therefore needs `node
widgets/scripts/fetch-pins.mjs` in the same pull request, or the pin check
fails.

Re-running this is how a future upgrade re-pins: it always re-resolves
against the live CDN, so the diff in `pins.json` and `dist/` is the whole
review surface for "did the third party change what these bytes are". It
never runs at deploy or build time -- only here, by hand, to produce a new
commit.
