# syntax=docker/dockerfile:1
# The directive above has to be the first line — a comment before it makes it
# an ordinary comment. It pins the stable frontend, which is what guarantees
# `RUN --mount=type=secret` below rather than leaving it to whichever frontend
# the local daemon happens to bundle.

# better-sqlite3 (the store's driver) ships prebuilt N-API binaries for glibc
# and musl inside its npm package (prebuilds/linuxmusl-x64.node), selected at
# load time on musl, so neither base needs a compiler. alpine is the smallest
# base with no critical or high finding lacking a fix (see the PR body).
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

# Alpine's zlib fix is not in the base's package index until upgraded here.
RUN apk upgrade --no-cache zlib

# Node 26 ships without corepack, so pnpm is installed at the version the
# package.json pins. npm is removed in the same layer: it is only the installer
# for pnpm, and its bundled dependencies are not needed at run time. pnpm and
# its store are removed after the last pnpm step (see `pnpm prune` below).
RUN npm install --global pnpm@11.17.0 \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# `@branchleft/tsconfig` is a build-time dependency hosted on GitHub Packages,
# which rejects anonymous reads even for a public package. The token arrives as
# a BuildKit secret and is written to a userconfig that lives and dies inside
# this one RUN, so it never becomes part of a layer and is not reachable from
# the built image. `pnpm install` fails closed if the secret is absent, rather than
# falling back to an anonymous request.
#
# --ignore-scripts: no install script is needed to build or run this image
# (better-sqlite3 loads its bundled prebuilt binary), and pnpm would otherwise
# try a node-gyp rebuild this image has no toolchain for.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc pnpm install --frozen-lockfile --ignore-scripts; \
      rm -f /tmp/npmrc'

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# Read from disk at startup by dist/migrate.js; without them a fresh volume
# cannot be created and an existing one cannot be migrated.
COPY drizzle ./drizzle

# Dev dependencies (typescript, vitest, etc.) are only needed for the build
# step above — pruning them keeps @types/*, tsc and the test toolchain out
# of the image that actually ships.
# pnpm ships its own copy of undici and tar, and its store holds every locked
# package, dev ones included. Neither is needed at run time, so both go in the
# same layer as the last pnpm call.
RUN pnpm prune --prod \
 && rm -rf /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx /root/.local/share/pnpm /root/.cache/pnpm

USER node
EXPOSE 8080 25
CMD ["node", "dist/server.js"]
