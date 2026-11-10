# syntax=docker/dockerfile:1
# The directive above has to be the first line -- a comment before it makes
# it an ordinary comment. It pins the stable frontend, which is what
# guarantees `RUN --mount=type=secret` below rather than leaving it to
# whichever frontend the local daemon happens to bundle.
#
# Built from the repository root, not this directory, because the collector
# depends on the shared dead-man's switch through a relative `link:` dependency
# and the build context must contain both packages:
#   docker build -f services/mail-collector/Dockerfile --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
# Dockerfile.dockerignore beside this file narrows that context to the two
# packages.

# No native dependency needs node-gyp here, so there is no musl-compatibility
# reason to prefer -alpine. bookworm-slim is chosen instead because it tracks
# Debian's glibc and Node's own release-testing matrix -- the same choice
# services/mailgun-shim makes, for the same reason.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

# The base image's bundled npm carries fixable advisories (undici,
# brace-expansion, tar, ip-address); npm 12 carries the fixed versions.
# Node 26 ships without corepack, so pnpm is installed at the version the
# package.json files pin.
RUN npm install --global npm@12.2.2 \
    && npm install --global pnpm@11.17.0

# Both packages keep their repository-relative layout, so the lockfile's
# `../../deadmans-switch` link resolves inside the image exactly as it does in
# a checkout.
WORKDIR /app/deadmans-switch
COPY deadmans-switch/.npmrc deadmans-switch/package.json deadmans-switch/pnpm-lock.yaml ./

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

COPY deadmans-switch/tsconfig.json deadmans-switch/tsconfig.build.json ./
COPY deadmans-switch/src ./src
RUN pnpm run build

WORKDIR /app/services/mail-collector
COPY services/mail-collector/.npmrc services/mail-collector/package.json services/mail-collector/pnpm-lock.yaml services/mail-collector/pnpm-workspace.yaml ./
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc pnpm install --frozen-lockfile; \
      rm -f /tmp/npmrc'

COPY services/mail-collector/tsconfig.json services/mail-collector/tsconfig.build.json ./
COPY services/mail-collector/src ./src
RUN pnpm run build

# Dev dependencies (typescript, vitest, smtp-server test helpers, etc.) are
# only needed for the build and test steps -- pruning them keeps the test
# toolchain out of the image that actually ships. The shared package ships
# only its compiled dist/, the same as render-core in demo-gate.
RUN pnpm prune --prod && rm -rf src \
    && cd /app/deadmans-switch && pnpm prune --prod && rm -rf src

USER node

# The collector's own healthz/metrics surface -- never the drain port of any
# host it reaches into, and never published to a wider network than ops1's
# own monitoring reach.
EXPOSE 8080

CMD ["node", "dist/server.js"]
