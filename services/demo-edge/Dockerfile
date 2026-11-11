# syntax=docker/dockerfile:1
# Caddy 2.11.9 with the Hetzner DNS module compiled in, for the demo edge's
# wildcard certificate (DNS-01). .github/workflows/demo-edge-image.yml builds
# and publishes it; see README.md beside this file.

# Both base images are pinned by digest so a re-pointed tag cannot change
# what is built. Re-read the digests when the Caddy tag is bumped.
# The two --replace flags move Go modules that Caddy 2.11.9 resolves to older
# releases onto their patched versions (GO-2026-6860, GO-2026-6865).
FROM caddy:2.11.9-builder-alpine@sha256:f7d08b96ba62ff0ae985079c0db4e0f97acb1f174e0e111aebe1f8a4b2d56f31 AS builder
RUN xcaddy build v2.11.9 --with github.com/caddy-dns/hetzner/v2@v2.0.1 --replace golang.org/x/net=golang.org/x/net@v0.62.0 --replace github.com/klauspost/compress=github.com/klauspost/compress@v1.20.2 --output /usr/bin/caddy

FROM caddy:2.11.9-alpine@sha256:fc9cbc100585871d18d4e451cca7021785c90a7006087427ae5ceb3e4efe6424
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# The base's zlib 1.3.2 carries CVE-2026-4738 (Critical). 1.4-r0 is the Alpine
# 3.24 release that fixes it, pinned exactly so the build installs the version
# the scan was run against.
RUN apk add --no-cache zlib=1.4-r0

# Its own RUN so the build fails when the module is missing from the binary.
RUN caddy list-modules | grep -qx 'dns.providers.hetzner'
