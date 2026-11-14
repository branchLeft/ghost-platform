# syntax=docker/dockerfile:1
# The directive above has to be the first line; see services/mail-collector/Dockerfile.
#
# One image for the tenant portal and the owner console: two entry points of
# one package, chosen by the container's command (`node dist/tenant/main.js` or
# `node dist/console/main.js`). They stay two applications at run time: each
# container gets its own port, hostname, sign-in client and database login.
#
# The build context is the repository root, because the applications depend on
# four sibling packages by `link:` path (portal/data, services/identity,
# services/request-guard and services/provisioning-controller) and pnpm links
# them rather than copying. The final layout therefore keeps all five at their
# repository paths, built, with development dependencies pruned. From the
# provisioning controller the portal takes only its generated provisioning-API
# client (`ghost-platform-provisioning-controller/provisioning-api`); the
# in-memory mock beside it is not part of the image (Dockerfile.dockerignore).
#
# Alpine (musl), not Debian: the image scan of 2026-11-10 (grype 0.115.0) found
# the Debian base carried 53 blocking findings with no published fix, and the
# Alpine base carries none. Every runtime dependency is pure JavaScript, so
# nothing here needs a glibc build.
#
# Pinned by digest: the linux/amd64 manifest of node:26.13.0-alpine, read from
# the registry. A re-pointed tag cannot change what ships.
FROM node:26.13.0-alpine@sha256:b2646ba6d774dc22c24d89fc37103fcf4c4467e870c78b9519aa403300b2835a

# zlib 1.3.2 in this base has CVE-2026-4738 (critical), fixed in zlib 1.4-r0.
# Remove this line once the pinned base carries the fixed package.
RUN apk upgrade --no-cache zlib

WORKDIR /app

COPY portal/data/ portal/data/
COPY services/identity/ services/identity/
COPY services/request-guard/ services/request-guard/
COPY services/provisioning-controller/ services/provisioning-controller/
COPY portal/apps/ portal/apps/

# Node 26 ships without corepack, so pnpm is installed at the version the
# package.json files pin. npm is used only for this install and is then removed
# in the same RUN: the base's bundled npm carries undici and brace-expansion
# versions with published fixes, and the image runs nothing that needs npm.
#
# `@branchleft/tsconfig` is a build-time dependency hosted on GitHub Packages,
# which rejects anonymous reads. The token arrives as a BuildKit secret and is
# written to a userconfig that lives and dies inside this one RUN, so it never
# becomes part of a layer. `pnpm install` fails closed if the secret is absent.
# The order matters: each application imports its siblings' built output.
# The pnpm store is deleted in the same RUN: it holds every platform's binaries
# of each package, which the image never runs and would otherwise ship.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'npm install --global pnpm@11.28.11; \
      printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      export NPM_CONFIG_USERCONFIG=/tmp/npmrc; \
      for dir in portal/data services/identity services/request-guard services/provisioning-controller portal/apps; do \
        (cd "$dir" && pnpm install --frozen-lockfile && pnpm run build); \
      done; \
      for dir in portal/apps portal/data services/identity services/request-guard services/provisioning-controller; do \
        (cd "$dir" && pnpm prune --prod); \
      done; \
      rm -f /tmp/npmrc; \
      store="$(pnpm store path)"; \
      rm -rf "$store"; \
      rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx'

WORKDIR /app/portal/apps

USER node

# Each container sets its own PORT; the image publishes nothing itself.
CMD ["node", "dist/tenant/main.js"]
