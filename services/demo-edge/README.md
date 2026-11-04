# demo-edge

Caddy 2.11.4 with the Hetzner DNS module (`github.com/caddy-dns/hetzner/v2`
v2.0.1) compiled in. It is the image for the demo host's own TLS termination:
one wildcard certificate, issued by DNS-01, covers every demo slot name, so
no slot name reaches a certificate transparency log. The Caddyfile is
rendered by `demo-host/provision/render_demo_site.py`; see
`demo-host/provision/render_demo_site.md`.

**Status:** not published, and nothing delivers it to a host. The only thing
that builds it is `demo-host/provision/test_demo_edge_wildcard.py`, in the
`repo-tooling-ci` unit-test step: it checks the module is registered and that
the rendered Caddyfile manages only the wildcard name.

## Build

```sh
docker build -f services/demo-edge/Dockerfile services/demo-edge
```

The build stage uses `xcaddy`; the final stage copies the binary onto the
pinned `caddy:2.11.4-alpine` base. A `RUN` at the end fails the build when
`dns.providers.hetzner` is absent from `caddy list-modules`.

## Configuration

- The module reads the Hetzner Cloud API token only through the Caddyfile
  directive `dns hetzner {file./abs/path}` or `dns hetzner {env.NAME}`. The
  block form (`dns hetzner { api_token ... }`) is broken in module v2.0.1,
  and the renderer does not emit it.
- Production uses the file form. The token file is root-only on the host and
  is mounted read-only into the container. The token never appears in the
  Caddyfile or in the image.
- Caddy's data directory (`/data`) holds the issued certificate and account
  state. It must be a persistent volume, or each restart re-issues.
