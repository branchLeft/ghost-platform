# syntax=docker/dockerfile:1
# Built from the repository root, not this directory, because the service
# depends on render-core and services/request-guard through relative `link:`
# dependencies and the build context must contain all three:
#   docker build -f services/demo-gate/Dockerfile --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
# Dockerfile.dockerignore beside this file narrows that context to the three
# packages.
#
# Alpine (musl), not Debian, on the same base as portal/Dockerfile: its image
# scan found the Debian base carried findings with no published fix, and every
# runtime dependency here is pure JavaScript, so nothing needs a glibc build.
#
# Pinned by digest: the linux/amd64 manifest of node:26.13.0-alpine, read from
# the registry. A re-pointed tag cannot change what ships.
FROM node:26.13.0-alpine@sha256:b2646ba6d774dc22c24d89fc37103fcf4c4467e870c78b9519aa403300b2835a

# zlib 1.3.2 in this base has CVE-2026-4738 (critical), fixed in zlib 1.4-r0.
# Remove this line once the pinned base carries the fixed package.
RUN apk upgrade --no-cache zlib

WORKDIR /app

# Both packages keep their repository-relative layout, so each lockfile's
# `link:` paths resolve inside the image exactly as they do in a checkout.
COPY render-core/ render-core/
COPY services/request-guard/ services/request-guard/
COPY services/demo-gate/ services/demo-gate/

# Node 26 ships without corepack, so pnpm is installed at the version the
# demo gate's package.json pins. Everything that only the build needs is
# removed in the same RUN, because a later layer's delete would leave it in an
# earlier one: npm, pnpm itself (the image runs `node` and nothing else), the
# pnpm store (it holds every platform's binaries of each package), and the
# token userconfig.
#
# `@branchleft/tsconfig` is a build-time dependency hosted on GitHub Packages,
# which rejects anonymous reads. The token arrives as a BuildKit secret and is
# written to a userconfig that lives and dies inside this one RUN, so it never
# becomes part of a layer. `pnpm install` fails closed if the secret is absent.
# The order matters: each package imports its siblings' built output.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'npm install --global pnpm@11.17.0; \
      printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      export NPM_CONFIG_USERCONFIG=/tmp/npmrc; \
      for dir in render-core services/request-guard services/demo-gate; do \
        (cd "/app/$dir" && pnpm install --frozen-lockfile && pnpm run build); \
      done; \
      for dir in render-core services/request-guard services/demo-gate; do \
        (cd "/app/$dir" && pnpm prune --prod); \
      done; \
      rm -rf /app/render-core/src /app/render-core/node_modules \
        /app/services/request-guard/src /app/services/request-guard/node_modules \
        /app/services/demo-gate/src; \
      rm -f /tmp/npmrc; \
      store="$(pnpm store path)"; \
      rm -rf "$store"; \
      rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx; \
      rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx \
        /usr/local/bin/pn /usr/local/bin/pnx'

WORKDIR /app/services/demo-gate

USER node

# In front of a demo host's slots the gate listens where only the edge can
# reach it; the address is set by whoever runs the container.
ENV LISTEN_HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "dist/server.js"]
