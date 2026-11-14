# syntax=docker/dockerfile:1
# Test-only image for the demo edge's wildcard proof against a local ACME CA:
# Caddy 2.11.5 with a stub DNS provider (stubdns), Pebble and
# pebble-challtestsrv at pinned versions, a DNS front for zone lookups
# (tools/soashim), a throwaway TLS identity generator (tools/mkcert), and the
# run script. Never published or deployed; see ../test_demo_edge_tier2.md.

# Pinned by digest so a re-pointed tag cannot change what is built. The
# builder image (Go 1.26.8, the 2.11.4 tag: no 2.11.5 builder tag exists yet)
# carries a Go toolchain new enough for Caddy 2.11.5 (Go 1.26.0 or later) and Pebble 2.10.1 (Go 1.24). Re-read the digests when either tag is
# bumped.
#
# Every Go program here is built from a committed module (caddy/, ca/, tools/)
# whose go.sum lists the hash of every module it needs, so a build never asks
# the checksum database about anything and each download is still checked
# against go.sum. Do not set GOSUMDB, GOFLAGS or the like here, and do not
# build with a command that resolves versions (xcaddy, go install pkg@version,
# go get): a missing hash must fail the build. See ../test_demo_edge_tier2.md.
FROM caddy:2.11.4-builder-alpine@sha256:0aa610043dab5da82ad0a0268e46bb852785e6f5160f12f1c6fe3f42903d7e1b AS caddy
# A plain go build leaves no file capability on the binary, which the proof
# needs: it runs with every capability dropped.
ENV CGO_ENABLED=0
WORKDIR /src
COPY stubdns ./stubdns
COPY caddy ./caddy
WORKDIR /src/caddy
RUN mkdir -p /out && go build -trimpath -ldflags "-w -s" -o /out/caddy-tier2 .

FROM caddy:2.11.4-builder-alpine@sha256:0aa610043dab5da82ad0a0268e46bb852785e6f5160f12f1c6fe3f42903d7e1b AS ca
ENV CGO_ENABLED=0 GOBIN=/out
WORKDIR /src
COPY ca ./
RUN mkdir -p /out && go install tool

FROM caddy:2.11.4-builder-alpine@sha256:0aa610043dab5da82ad0a0268e46bb852785e6f5160f12f1c6fe3f42903d7e1b AS tools
ENV CGO_ENABLED=0
WORKDIR /src
COPY tools/go.mod tools/go.sum ./
RUN go mod download
COPY tools ./
RUN mkdir -p /out && go build -trimpath -o /out/ ./soashim ./mkcert

FROM python:3.12-alpine@sha256:e6dae589c1c05976188fd3bd019afd091445fc533ed2ea29001beddc7368a9c8
COPY --from=caddy /out/caddy-tier2 /usr/local/bin/caddy-tier2
COPY --from=ca /out/pebble /out/pebble-challtestsrv /usr/local/bin/
COPY --from=tools /out/soashim /out/mkcert /usr/local/bin/
COPY run_wildcard_proof.py /opt/tier2/run_wildcard_proof.py

# Its own RUN so the build fails when a binary is missing or not static.
RUN caddy-tier2 list-modules | grep -qx 'dns.providers.challtestsrv' \
    && pebble -version \
    && pebble-challtestsrv -h 2>&1 | grep -q management \
    && python3 --version

USER 65532:65532
