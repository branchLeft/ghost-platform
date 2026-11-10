# syntax=docker/dockerfile:1
# The directive above has to be the first line -- a comment before it makes
# it an ordinary comment. It pins the stable frontend, which is what
# guarantees `RUN --mount=type=secret` below rather than leaving it to
# whichever frontend the local daemon happens to bundle.

# No native dependency needs node-gyp here, so there is no musl-compatibility
# reason to prefer -alpine. bookworm-slim is chosen instead because it tracks
# Debian's glibc and Node's own release-testing matrix -- the same choice
# services/mailgun-shim makes, for the same reason.
# Pinned by digest as well as tag: the digest is the multi-arch index of
# node:26.5.0-bookworm-slim as read from Docker Hub with
# `docker buildx imagetools inspect node:26.5.0-bookworm-slim`, so a re-pointed
# tag cannot change what ships. Re-read it when the tag is bumped.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

# The npm bundled in the base image carries undici and brace-expansion below
# their fixed releases. npm 12.2.2 bundles undici 6.29.1 and brace-expansion
# 5.0.12, so it is installed first and the bundled copy is replaced.
RUN npm install --global npm@12.2.2

# Node 26 ships without corepack, so pnpm is installed at the version the
# package.json pins.
RUN npm install --global pnpm@11.17.0

WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml ./

# `@branchleft/tsconfig` is a build-time dependency hosted on GitHub Packages,
# which rejects anonymous reads even for a public package. The token arrives
# as a BuildKit secret and is written to a userconfig that lives and dies
# inside this one RUN, so it never becomes part of a layer and is not
# reachable from the built image. `pnpm install` fails closed if the secret is
# absent, rather than falling back to an anonymous request.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc pnpm install --frozen-lockfile; \
      rm -f /tmp/npmrc'

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# Dev dependencies (typescript, vitest, etc.) are only needed for the build
# step above -- pruning them keeps @types/*, tsc and the test toolchain out
# of the image that actually ships.
RUN pnpm prune --prod

USER node

# This is the slot's health port, reached over the loopback address the
# sidecar shares with Ghost via the Ghost container's network namespace --
# never published on its own, because the slot that starts this container
# is the one that owns the port mapping (see the drain-flag design doc).
EXPOSE 8080

CMD ["node", "dist/server.js"]
