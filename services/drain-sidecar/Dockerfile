# syntax=docker/dockerfile:1
# The directive above has to be the first line -- a comment before it makes
# it an ordinary comment. It pins the stable frontend, which is what
# guarantees `RUN --mount=type=secret` below rather than leaving it to
# whichever frontend the local daemon happens to bundle.

# Alpine (musl, busybox sh, apk) is chosen because its base scans with no
# unfixable findings, where bookworm-slim carries many without a published
# fix. Nothing here needs glibc: the dependencies are pure JavaScript, and
# every shell step below is POSIX sh.
# Pinned by digest as well as tag: the digest is the linux/amd64 manifest of
# node:26.13.0-alpine, read from Docker Hub and confirmed against the registry
# manifest endpoint, so a re-pointed tag cannot change what ships. Re-read it
# when the tag is bumped.
FROM node:26.13.0-alpine@sha256:b2646ba6d774dc22c24d89fc37103fcf4c4467e870c78b9519aa403300b2835a

# zlib carries a critical finding whose fixed release is newer than the base.
RUN apk upgrade --no-cache zlib

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

# npm is only needed to install pnpm, and pnpm only to install, build and
# prune. The service runs `node` alone, so both package managers, their
# bundled packages (pnpm carries its own copies of tar and undici) and their
# caches are removed rather than shipped unused.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm \
    /usr/local/lib/node_modules/pnpm /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/pn /usr/local/bin/pnx \
    /root/.local/share/pnpm /root/.cache

USER node

# This is the slot's health port, reached over the loopback address the
# sidecar shares with Ghost via the Ghost container's network namespace --
# never published on its own, because the slot that starts this container
# is the one that owns the port mapping (see the drain-flag design doc).
EXPOSE 8080

CMD ["node", "dist/server.js"]
