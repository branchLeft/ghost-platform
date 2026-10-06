# syntax=docker/dockerfile:1
# The directive above has to be the first line; see services/mail-collector/Dockerfile.
#
# One image for the tenant portal and the owner console: two entry points of
# one package, chosen by the container's command (`node dist/tenant/main.js` or
# `node dist/console/main.js`). They stay two applications at run time: each
# container gets its own port, hostname, sign-in client and database login.
#
# The build context is the repository root, because the applications depend on
# two sibling packages by `file:` path (portal/data and services/identity) and
# npm links them rather than copying. The final layout therefore keeps all
# three at their repository paths, built, with development dependencies pruned.
FROM node:26.5.0-bookworm-slim

WORKDIR /app

COPY portal/data/ portal/data/
COPY services/identity/ services/identity/
COPY portal/apps/ portal/apps/

# `@branchleft/tsconfig` is a build-time dependency hosted on GitHub Packages,
# which rejects anonymous reads. The token arrives as a BuildKit secret and is
# written to a userconfig that lives and dies inside this one RUN, so it never
# becomes part of a layer. `npm ci` fails closed if the secret is absent.
# The order matters: each application imports its siblings' built output.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      export NPM_CONFIG_USERCONFIG=/tmp/npmrc; \
      for dir in portal/data services/identity portal/apps; do \
        (cd "$dir" && npm ci && npm run build); \
      done; \
      for dir in portal/apps portal/data services/identity; do \
        (cd "$dir" && npm prune --omit=dev); \
      done; \
      rm -f /tmp/npmrc'

WORKDIR /app/portal/apps

USER node

# Each container sets its own PORT; the image publishes nothing itself.
CMD ["node", "dist/tenant/main.js"]
