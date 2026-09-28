# syntax=docker/dockerfile:1
# The directive above has to be the first line — a comment before it makes it
# an ordinary comment. It pins the stable frontend, which is what guarantees
# `RUN --mount=type=secret` below rather than leaving it to whichever frontend
# the local daemon happens to bundle.

# better-sqlite3 (the store's driver) ships prebuilt glibc and musl binaries
# inside its npm package, so neither base needs a compiler. bookworm-slim is
# chosen because it tracks Debian's glibc and Node's own release-testing
# matrix, which matters more at this service's scale than the size delta.
FROM node:26.5.0-bookworm-slim

WORKDIR /app

COPY .npmrc package.json package-lock.json ./

# `@branchleft/tsconfig` is a build-time dependency hosted on GitHub Packages,
# which rejects anonymous reads even for a public package. The token arrives as
# a BuildKit secret and is written to a userconfig that lives and dies inside
# this one RUN, so it never becomes part of a layer and is not reachable from
# the built image. `npm ci` fails closed if the secret is absent, rather than
# falling back to an anonymous request.
#
# --ignore-scripts: no install script is needed to build or run this image
# (better-sqlite3 loads its bundled prebuilt binary), and npm would otherwise
# try a node-gyp rebuild this image has no toolchain for.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc npm ci --ignore-scripts; \
      rm -f /tmp/npmrc'

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Read from disk at startup by dist/migrate.js; without them a fresh volume
# cannot be created and an existing one cannot be migrated.
COPY drizzle ./drizzle

# Dev dependencies (typescript, vitest, etc.) are only needed for the build
# step above — pruning them keeps @types/*, tsc and the test toolchain out
# of the image that actually ships.
RUN npm prune --omit=dev

USER node
EXPOSE 8080 25
CMD ["node", "dist/server.js"]
