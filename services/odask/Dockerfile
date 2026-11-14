# syntax=docker/dockerfile:1
# Built from the repository root so the invocation matches the other services':
#   docker build -f services/odask/Dockerfile --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
# Dockerfile.dockerignore beside this file narrows that context to the service
# alone. render-core is not in the context: the service installs the version
# its package.json pins from GitHub Packages.

FROM node:26.5.0-bookworm-slim

# Node 26 ships without corepack, so pnpm is installed at the version the
# package.json files pin.
RUN npm install --global pnpm@11.17.0

# `@branchleft/tsconfig` and `@branchleft/ghost-platform-render-core` are
# dependencies on GitHub Packages. The token arrives as a BuildKit secret
# written to a userconfig that lives and dies inside one RUN, so it never
# enters a layer. `pnpm install` fails closed if the secret is absent.
WORKDIR /app/services/odask
COPY services/odask/.npmrc services/odask/package.json services/odask/pnpm-lock.yaml ./
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc pnpm install --frozen-lockfile; \
      rm -f /tmp/npmrc'
COPY services/odask/tsconfig.json services/odask/tsconfig.build.json ./
COPY services/odask/src ./src
RUN pnpm run build

# The runtime needs the compiled output and the production dependencies:
# no sources, no toolchain.
RUN pnpm prune --prod && rm -rf src

USER node

# Reachable only from its own edge (LLD-5 E2) -- the bind address is the
# one thing this image never sets a default for (see src/config.ts):
# whoever runs the container must set BIND_HOST explicitly, and the process
# refuses to start without it.
EXPOSE 9000

CMD ["node", "dist/server.js"]
