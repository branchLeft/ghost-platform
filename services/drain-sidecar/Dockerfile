# syntax=docker/dockerfile:1
# The directive above has to be the first line -- a comment before it makes
# it an ordinary comment. It pins the stable frontend, which is what
# guarantees `RUN --mount=type=secret` below rather than leaving it to
# whichever frontend the local daemon happens to bundle.

# No native dependency needs node-gyp here, so there is no musl-compatibility
# reason to prefer -alpine. bookworm-slim is chosen instead because it tracks
# Debian's glibc and Node's own release-testing matrix -- the same choice
# services/mailgun-shim makes, for the same reason.
FROM node:26.5.0-bookworm-slim

WORKDIR /app

COPY .npmrc package.json package-lock.json ./

# `@branchleft/tsconfig` is a build-time dependency hosted on GitHub Packages,
# which rejects anonymous reads even for a public package. The token arrives
# as a BuildKit secret and is written to a userconfig that lives and dies
# inside this one RUN, so it never becomes part of a layer and is not
# reachable from the built image. `npm ci` fails closed if the secret is
# absent, rather than falling back to an anonymous request.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc npm ci; \
      rm -f /tmp/npmrc'

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Dev dependencies (typescript, vitest, etc.) are only needed for the build
# step above -- pruning them keeps @types/*, tsc and the test toolchain out
# of the image that actually ships.
RUN npm prune --omit=dev

USER node

# This is the slot's health port, reached over the loopback address the
# sidecar shares with Ghost via the Ghost container's network namespace --
# never published on its own, because the slot that starts this container
# is the one that owns the port mapping (see the drain-flag design doc).
EXPOSE 8080

CMD ["node", "dist/server.js"]
