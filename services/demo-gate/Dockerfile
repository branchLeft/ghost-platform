# syntax=docker/dockerfile:1
# Built from the repository root, not this directory, because the service
# depends on render-core through a relative `file:` link and the build
# context must contain both:
#   docker build -f services/demo-gate/Dockerfile --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
# Dockerfile.dockerignore beside this file narrows that context to the two
# packages.

FROM node:26.5.0-bookworm-slim

# Both packages keep their repository-relative layout, so the lockfile's
# `../../render-core` link resolves inside the image exactly as it does in a
# checkout.
WORKDIR /app/render-core
COPY render-core/.npmrc render-core/package.json render-core/package-lock.json ./

# `@branchleft/tsconfig` is a build-time dependency on GitHub Packages. The
# token arrives as a BuildKit secret written to a userconfig that lives and
# dies inside one RUN, so it never enters a layer. `npm ci` fails closed if
# the secret is absent.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc npm ci; \
      rm -f /tmp/npmrc'
COPY render-core/tsconfig.json render-core/tsconfig.build.json ./
COPY render-core/src ./src
RUN npm run build

WORKDIR /app/services/demo-gate
COPY services/demo-gate/.npmrc services/demo-gate/package.json services/demo-gate/package-lock.json ./
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc npm ci; \
      rm -f /tmp/npmrc'
COPY services/demo-gate/tsconfig.json services/demo-gate/tsconfig.build.json ./
COPY services/demo-gate/src ./src
RUN npm run build

# The runtime needs render-core's compiled output and nothing else of it:
# no sources, no toolchain.
RUN npm prune --omit=dev && rm -rf src /app/render-core/node_modules /app/render-core/src

USER node

# In front of a demo host's slots the gate listens where only the edge can
# reach it; the address is set by whoever runs the container.
ENV LISTEN_HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "dist/server.js"]
