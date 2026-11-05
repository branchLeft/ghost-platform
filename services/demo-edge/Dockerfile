# syntax=docker/dockerfile:1
# Caddy 2.11.4 with the Hetzner DNS module compiled in, for the demo edge's
# wildcard certificate (DNS-01). .github/workflows/demo-edge-image.yml builds
# and publishes it; see README.md beside this file.

# Both base images are pinned by digest so a re-pointed tag cannot change
# what is built. Re-read the digests when the Caddy tag is bumped.
FROM caddy:2.11.4-builder-alpine@sha256:0aa610043dab5da82ad0a0268e46bb852785e6f5160f12f1c6fe3f42903d7e1b AS builder
RUN xcaddy build v2.11.4 --with github.com/caddy-dns/hetzner/v2@v2.0.1 --output /usr/bin/caddy

FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Its own RUN so the build fails when the module is missing from the binary.
RUN caddy list-modules | grep -qx 'dns.providers.hetzner'
