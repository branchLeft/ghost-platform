# test-demo-edge.sh

## What this proves

The Caddyfile that `render_demo_site.py` renders, loaded by a real Caddy
beside the real demo gate image, over TLS verified against Caddy's local root
(copied out of the container and trusted explicitly; verification is never
disabled) and a resolved name (no public name exists before the demo goes public). Stand-ins:
two colour upstreams and a health router that answers per colour from the
`X-Colour-Upstream` header, all in one network namespace as on the host.

- without the gate cookie every path answers 401, `/ghost/` and
  `/ghost/api/admin/` included, for GET, POST, PUT and DELETE
- with the cookie the site serves and every response carries `noindex` and
  the content policy
- the members-upload `POST` is refused (403) in every spelling Ghost routes to
  the import (no trailing slash, `v2|v3|v4|canary` prefixes, case, encoded and
  dot segments) and the `GET` is not
- draining the serving colour moves traffic to the other with no reload, and
  back again, so the check tells the colours apart

## Sabotage

`DEMO_EDGE_PROOF_SABOTAGE=exempt-ghost` exempts `/ghost/*` from
`forward_auth` in the rendered file; `=narrow-import` narrows the members-import
matcher to one literal path. Each must make the script exit non-zero.

## Local use

`DEMO_EDGE_PROOF_LEGACY_IMAGE=1` accepts a gate image built before leases
carried a `hashId`. CI builds fresh and never sets it.
