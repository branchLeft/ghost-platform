# test-demo-edge.sh

## What this proves

The Caddyfile that `render_demo_site.py` renders, loaded by a real Caddy
beside the real demo gate image, over TLS verified against Caddy's local root
(copied out of the container and trusted explicitly; verification is never
disabled) and a resolved name (no public name exists before the demo goes public). Stand-ins:
two colour upstreams and a health router that answers per colour from the
`X-Colour-Upstream` header, all in one network namespace as on the host.

The renderer is called as `--base <base> --site 0=<edge json> --tls 'tls
internal'`. That is the proof-only TLS source: the renderer has no default and
no production source that works without DNS credentials, so the proof names
Caddy's local CA explicitly. Production passes `--dns-directive` instead and
never `--tls`; the proof does not exercise that path or issue a real
certificate (see `render_demo_site.md`). The script adds `local_certs`,
`skip_install_trust` and `auto_https disable_redirects` to the global block
with `sed` before Caddy loads it.

- the gate runs from the environment file `render_demo_site.py` renders
  (`--gate-env-out`), not a hand-typed copy of it, so the trusted-proxy
  address the proof uses is the one the host would get
- without the gate cookie every path answers 401, `/ghost/` and
  `/ghost/api/admin/` included, for GET, POST, PUT and DELETE
- with the cookie the site serves and every response carries `noindex` and
  the content policy
- the members-upload `POST` is refused (403) in every spelling Ghost routes to
  the import (no trailing slash, `v2|v3|v4|canary` prefixes, case, encoded and
  dot segments) and the `GET` is not
- an uploaded file a browser would run is refused (403, every method) under
  `/content/files/`, `/content/images/` and `/content/media/` for the
  extensions `render_demo_site.py` lists, in upper and lower case and in the
  spellings Caddy must normalise (`%2e`, `./`, `//`, `..`, a query string, a
  trailing slash); with no cookie it is 401. The controls stay open: an image,
  a PDF, a `.jsx`, `/ghost/assets/app.js` and a `.js` outside the upload
  prefixes. `nosniff` is on a served response and on the refusal (ws#3078)
- draining the serving colour moves traffic to the other with no reload, and
  back again, so the check tells the colours apart
- a name under the wildcard that is no slot's, sent to the same address, gets
  a connection closed after the TLS handshake: no status line and no body
  (Node reports `socket hang up`). The slot's own name answering 401 in the same
  probe shows Caddy is up, so the closed connection is the rendered final
  `handle { abort }` and not an outage. Without that handler Caddy answers an
  empty 200 for such a name

## Sabotage

`DEMO_EDGE_PROOF_SABOTAGE=exempt-ghost` exempts `/ghost/*` from
`forward_auth` in the rendered file; `=narrow-import` narrows the members-import
matcher to one literal path; `=drop-abort` removes the wildcard's closing
`handle { abort }`; `=drop-upload-guard` makes the uploaded-file refusals
answer 200 instead of 403 (the script exits 2 if the edit matches nothing). Each
must make the script exit non-zero.

The edits are `sed` patterns anchored on the rendered file's indentation: the
slot's gated catch-all is the two-tab `handle {` (the one-tab `handle {` is the
closing abort), and the members-import matchers sit five tabs deep. A change to
the rendered nesting makes a pattern match nothing; the sabotage then leaves
the script green, and the workflow step that expects red fails. The workflow
runs `exempt-ghost`, `narrow-import` and `drop-upload-guard`; `drop-abort` is for local use until a
workflow step is added.

## Local use

`DEMO_EDGE_PROOF_LEGACY_IMAGE=1` accepts a gate image built before leases
carried a `hashId`. CI builds fresh and never sets it.
