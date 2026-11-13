# syntax=docker/dockerfile:1
# The directive above has to be the first line -- a comment before it makes
# it an ordinary comment. It pins the stable frontend, which is what
# guarantees `RUN --mount=type=secret` below rather than leaving it to
# whichever frontend the local daemon happens to bundle.
#
# Built from this directory:
#   docker build --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
#
# Run it as a non-root user on a read-only root filesystem with no
# capabilities and a single writable volume for WEBHOOK_STATE_DIR, for example:
#   docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
#     --user node -v STATE_VOLUME:/state ...
# The service dials nothing: it has no outbound dependency to allow.

# Alpine: the service has no native dependency, so musl is no obstacle, and
# the Alpine image carries far fewer packages than the Debian one, which keeps
# the scan free of unfixed libc, util-linux and gcc rows.
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

# zlib 1.3.2 in the base has a Critical advisory fixed in 1.4; the base image
# has not been rebuilt with it yet.
RUN apk upgrade --no-cache zlib

# pnpm is installed at the version package.json pins, then npm is removed: the
# image only runs node, and npm's bundled packages carry fixable advisories.
# Node 26 ships without corepack.
RUN npm install --global pnpm@11.28.11 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# `@branchleft/tsconfig` is a build-time dependency hosted on GitHub Packages,
# which rejects anonymous reads even for a public package. The token arrives
# as a BuildKit secret and is written to a userconfig that lives and dies
# inside this one RUN, so it never becomes part of a layer and is not
# reachable from the built image. `pnpm install` fails closed if the secret is
# absent, rather than falling back to an anonymous request.
#
# --ignore-scripts: no install script is needed to build or run this image.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc pnpm install --frozen-lockfile --ignore-scripts; \
      rm -f /tmp/npmrc'

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# Dev dependencies are only needed for the build above; the service itself
# imports Node's built-ins alone, so the shipped image carries no packages.
RUN pnpm prune --prod && rm -rf src

USER node

# The webhook listener and the drain listener. Both bind to the addresses in
# WEBHOOK_HOST and WEBHOOK_DRAIN_HOST, which the operator sets to private
# addresses; neither is meant to be published on a wider network than that.
EXPOSE 8080 8081

CMD ["node", "dist/server.js"]
