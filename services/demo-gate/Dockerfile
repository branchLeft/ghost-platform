# syntax=docker/dockerfile:1
# Built from the repository root, not this directory, because the service
# depends on services/request-guard through a relative `link:` dependency and
# the build context must contain both:
#   docker build -f services/demo-gate/Dockerfile --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
# Dockerfile.dockerignore beside this file narrows that context to the two
# packages. render-core is not in the context: the gate installs the version
# its package.json pins from GitHub Packages.

FROM node:26.5.0-bookworm-slim

# Node 26 ships without corepack, so pnpm is installed at the version the
# package.json files pin.
RUN npm install --global pnpm@11.17.0

# `@branchleft/tsconfig` and `@branchleft/ghost-platform-render-core` are
# dependencies on GitHub Packages. The token arrives as a BuildKit secret
# written to a userconfig that lives and dies inside one RUN, so it never
# enters a layer. `pnpm install` fails closed if the secret is absent.
#
# The request guard (the per-source ceiling and the trusted-proxy resolver) is
# linked by relative path, so both packages keep their repository-relative
# layout and the gate's own install finds its built output.
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

# The runtime needs the request guard's compiled output and nothing else of
# it: no sources, no toolchain.
RUN pnpm prune --prod && rm -rf src \
    /app/services/request-guard/node_modules /app/services/request-guard/src

USER node

# In front of a demo host's slots the gate listens where only the edge can
# reach it; the address is set by whoever runs the container.
ENV LISTEN_HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "dist/server.js"]
