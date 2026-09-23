# Self-hosted front-end widgets (branchLeft/workspace#1230)

The pinned `ghost:6.55.0` image loads six CDN script bundles plus one CDN
stylesheet by default, all on floating `~` version ranges (`forks/Ghost` at
`v6.55.0`, `ghost/core/core/shared/config/defaults.json:294-318`): `portal`,
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
component, built once epic branchLeft/workspace#1160 (the tenant edge) or
branchLeft/workspace#1254 (the demo edge) exists. This one exists so the
"zero third-party origins" claim can be proven against a real container
rather than asserted from config; whichever edge lands in production is
expected to fold `origin/Caddyfile`'s `file_server` block into its own
config rather than run this container permanently. `/bl-assets/` is the URL
path LLD-5 §06 marks incidental.

**Not wired into `infra/tenant/environment.ts`.** Real tenants have no edge
in front of Ghost yet (that is epic #1160's job), so pointing production env
vars at a `/bl-assets/` path nothing serves would be a config lie. That
wiring belongs to whichever story lands the first real edge and consumes
these pins -- `pins.json` is written so it can.

## The live proof

`proof/run-proof.sh` runs the whole thing against real Docker containers: a
GREEN pass with every override set, a RED (sabotage) pass with one override
(`sodoSearch__url`) removed, and a GREEN pass restoring it -- each pass
driven by a real headless Chromium (`proof/capture-network.mjs`, via
Playwright) through the home page, Portal's sign-in overlay, search, a post
with comments, and a standalone page embedding the signup-form widget
(`proof/signup-embed.html` -- signup-form is never loaded by Ghost's own
site, so this mimics how a tenant actually embeds it). It asserts every
captured request's origin equals the origin under test.

Run it from the repo root: `./widgets/proof/run-proof.sh` (needs Docker and
`widgets/proof`'s own `npm install` for Playwright -- kept out of the root
package.json and out of CI deliberately; see `proof/package.json`).
