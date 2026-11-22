# csp/gate: the magic-link gate

The third gate beside the content-policy regression gate (hostile content is
blocked) and the checkout gate (legitimate payment traffic is not). This one
proves a reader can sign up, follow the link in the mail they are sent, and be
signed in, all under the strict policy, with the browser reporting **zero**
content-policy violations. It needs no real mail: the tenant's mail goes to a
spool on the gate's own Docker network and stays there.

## What it runs

`magic_link_gate.py` (Docker, Node 22.18 or later, Chromium via `csp/proof`,
render-core built):

1. Starts a mail spool (`scripts/mail-gate/spool-standin`, built locally; set
   `CSP_MAGIC_LINK_SPOOL_IMAGE` to run the pinned mailgun-shim instead) on a
   private network with a fixed subnet, and registers a sender domain with it.
2. Starts the pinned Ghost image as a disposable tenant: sqlite, local scanning
   storage, its mail transport pointed at the spool by name (the spool key reaches
   it through the environment only), and its widget addresses taken from
   render-core's own table (`csp/proof/render-widgets.ts` prints
   `OWN_ORIGIN_WIDGETS`), the addresses a tenant on `widgets: 'own-origin'`
   gets, so Portal loads from the tenant's own origin.
3. `csp/proof/setup-content.mjs` takes Ghost through setup and publishes a post;
   `csp/derive/derive-script-hashes.mjs` derives the theme's script hashes from
   the clean pages; `csp/proof/render-header.mjs` renders the enforcing policy
   through render-core's built output. A Caddy origin then serves that policy.
4. `csp/proof/capture-magic-link.ts` drives a real Chromium: Portal's sign-up
   form is filled and sent, the magic link is read out of the spool
   (`csp/proof/mail-link.ts` decodes the MIME), followed, and Ghost must serve
   a member session; Portal's account page must then show the member. Violations
   are collected from every frame (Portal is an iframe), and every request off the
   tenant's origin is recorded.
5. `magic_link_verdict.py` judges the capture. Green only when every step ran in
   order, the mailed link points at the tenant's own origin, Ghost sent the
   browser back with `action=signup&success=true`, Portal's script was served
   from `/bl-assets/portal.min.js` on the tenant's origin (so a clean report is
   not a page that never ran Portal), nothing but an image left the origin, and
   no frame reported a violation.

Run it:

```sh
PATH=<node 22.18 or later>:$PATH csp/gate/magic_link_gate.py [--sabotage=MODE] [IMAGE]
```

The exit code is the verdict: 0 green, 1 red, 2 a refusal or a setup failure.
`CSP_MAGIC_LINK_PORT` (4331) and `CSP_MAGIC_LINK_DRAIN_PORT` (4332) move its two
host ports. It never runs against a host: every address is on the machine.

## Sabotage modes

Each breaks one thing the page needs, and must exit 1. A mode that finds nothing
to break in the rendered policy refuses (exit 2) rather than passing.

- `--sabotage=no-inline-style`: `'unsafe-inline'` removed from `style-src`.
  Portal writes its styles into its iframes, so every frame reports a
  `style-src-elem` violation.
- `--sabotage=no-self-script`: `'self'` removed from `script-src`. The theme's
  and Portal's own scripts are blocked and Portal never opens.
- `--sabotage=portal-on-cdn`: Ghost is given no widget addresses, so it keeps its
  compiled-in jsDelivr ones, which is what a tenant on render-core's default
  `widgets: 'cdn'` has. The policy blocks Portal's script and the sign-up form
  never renders. This is the one a tenant stack meets when the enforcing policy is
  switched on without `widgets: 'own-origin'`.

## Notes the run prints

The policy allows an image from any https origin, so a third-party image is not a
violation and the verdict does not fail on it, but the run prints it. A run today
shows Ghost's stock cover images from `static.ghost.org` (the default theme) and
the member's Gravatar (Portal's account page), the second of which sends a hash of
the reader's address to Gravatar.

## What it does not prove

- **Real mail.** The mail goes to a spool. Whether a message leaves the platform
  (the sending identity, the demo host's spool) is the mail programme's, not this
  gate's.
- **A deployed tenant.** The edge is a Caddy origin carrying the rendered header,
  not the production edge, and the Ghost is the pinned image with sqlite. Nothing
  here passes `widgets: 'own-origin'` or an enforcing policy to a deployed stack.
- **Sign-in and the paid path.** Sign-up is the flow; the sign-in link uses the same
  page. Paid checkout is the checkout gate's.
- **Any browser but Chromium.** WebKit crashes on the owner's Mac.

## Tests

`python3 -m unittest discover -s csp/gate -p 'test_magic_link_*.py' -v` (the runner
against recording fakes and the verdict against captures; each file also mutates
the real source one rule at a time and requires red), and from `csp/proof`:
`pnpm run typecheck`, then `node --test mail-link.test.ts` (the MIME decoding).
