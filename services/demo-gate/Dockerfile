# syntax=docker/dockerfile:1
# Built from the repository root, not this directory, because the service
# depends on render-core and services/request-guard through relative `link:`
# dependencies and the build context must contain all three:
#   docker build -f services/demo-gate/Dockerfile --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
# Dockerfile.dockerignore beside this file narrows that context to the three
# packages.

FROM node:26.5.0-bookworm-slim

# Node 26 ships without corepack, so pnpm is installed at the version the
# package.json files pin.
RUN npm install --global pnpm@11.17.0

# Both packages keep their repository-relative layout, so the lockfile's
# `../../render-core` link resolves inside the image exactly as it does in a
# checkout.
WORKDIR /app/render-core
COPY render-core/.npmrc render-core/package.json render-core/pnpm-lock.yaml ./

# `@branchleft/tsconfig` is a build-time dependency on GitHub Packages. The
# token arrives as a BuildKit secret written to a userconfig that lives and
# dies inside one RUN, so it never enters a layer. `pnpm install` fails closed if
# the secret is absent.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc pnpm install --frozen-lockfile; \
      rm -f /tmp/npmrc'
COPY render-core/tsconfig.json render-core/tsconfig.build.json ./
COPY render-core/src ./src
RUN pnpm run build

# The request guard (the per-source ceiling and the trusted-proxy resolver) is
# linked the same way, so the gate's own install finds its built output.
WORKDIR /app/services/request-guard
COPY services/request-guard/.npmrc services/request-guard/package.json services/request-guard/pnpm-lock.yaml ./
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc pnpm install --frozen-lockfile; \
      rm -f /tmp/npmrc'
COPY services/request-guard/tsconfig.json services/request-guard/tsconfig.build.json ./
COPY services/request-guard/src ./src
RUN pnpm run build

WORKDIR /app/services/demo-gate
COPY services/demo-gate/.npmrc services/demo-gate/package.json services/demo-gate/pnpm-lock.yaml ./
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc pnpm install --frozen-lockfile; \
      rm -f /tmp/npmrc'
COPY services/demo-gate/tsconfig.json services/demo-gate/tsconfig.build.json ./
COPY services/demo-gate/src ./src
RUN pnpm run build

# The runtime needs render-core's and the request guard's compiled output and
# nothing else of either: no sources, no toolchain.
RUN pnpm prune --prod && rm -rf src /app/render-core/node_modules /app/render-core/src \
    /app/services/request-guard/node_modules /app/services/request-guard/src

USER node

# In front of a demo host's slots the gate listens where only the edge can
# reach it; the address is set by whoever runs the container.
ENV LISTEN_HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "dist/server.js"]
