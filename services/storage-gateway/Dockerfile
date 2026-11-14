# syntax=docker/dockerfile:1
# The directive above has to be the first line -- a comment before it makes
# it an ordinary comment. It pins the stable frontend, which is what
# guarantees `RUN --mount=type=secret` below rather than leaving it to
# whichever frontend the local daemon happens to bundle.

# Two stages from one pinned base. The build stage holds pnpm, the compiler
# and the dev dependencies; the runtime stage takes only the compiled output
# and the production dependencies, and has no package manager at all.
#
# Alpine (musl, busybox sh, apk) is chosen because its base scans with no
# unfixable findings, where bookworm-slim carries many without a published
# fix. better-sqlite3 (the credential store's driver) ships a prebuilt musl
# binary inside its npm package, so no compiler is needed; the build smoke
# check in the publish workflow loads it from the built image.
# Pinned by digest as well as tag: the digest is the multi-architecture index
# of node:26.13.0-alpine, so a re-pointed tag cannot change what ships.
# Re-read it when the tag is bumped.
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS build

# zlib carries a critical finding whose fixed release is newer than the base.
RUN apk upgrade --no-cache zlib

# Node 26 ships without corepack, so pnpm is installed at the version the
# package.json pins.
RUN npm install --global pnpm@11.17.0

WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# `@branchleft/tsconfig` is a build-time dependency hosted on GitHub Packages,
# which rejects anonymous reads even for a public package. The token arrives
# as a BuildKit secret and is written to a userconfig that lives and dies
# inside this one RUN, so it never becomes part of a layer and is not
# reachable from the built image. `pnpm install` fails closed if the secret is
# absent, rather than falling back to an anonymous request.
#
# --ignore-scripts: no install script is needed to build or run this image
# (better-sqlite3 loads its bundled prebuilt binary), and there is no
# toolchain here for a node-gyp rebuild.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc pnpm install --frozen-lockfile --ignore-scripts; \
      rm -f /tmp/npmrc'

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# The credential store reads its migrations from disk at start-up.
COPY drizzle ./drizzle

# Dev dependencies (typescript, vitest, etc.) are only needed for the build
# step above; pruning leaves the production dependencies alone.
RUN pnpm prune --prod


FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS runtime

RUN apk upgrade --no-cache zlib

# npm is not needed to run the service, and its bundled packages are findings
# of their own, so the shipped image carries none.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle

# The one place the service writes. Run with a read-only root filesystem and
# mount a volume here (the spool and the credential store), owned by this
# user. The credential store's generation anchor belongs on a different
# volume, which the host mounts and names in STORAGE_GATEWAY_STORE_ANCHOR_PATH.
RUN mkdir -p /var/lib/storage-gateway && chown node:node /var/lib/storage-gateway

USER node

# The tenant-facing listener and the admin listener. The host decides the
# address each binds to (STORAGE_GATEWAY_LISTEN_HOST and
# STORAGE_GATEWAY_ADMIN_LISTEN_HOST) and which of them it publishes; nothing is
# published from here, and every secret arrives as a file the host mounts.
EXPOSE 8443 8444

# No curl or wget here: the check is node itself. It asks the listener's own
# address, over TLS when TLS is configured, and a certificate it is shown is
# not verified because the request never leaves this container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const h=process.env.STORAGE_GATEWAY_LISTEN_HOST;const host=!h||h==='0.0.0.0'||h==='::'?'127.0.0.1':h;const t=require(process.env.STORAGE_GATEWAY_TLS_CERT_FILE?'node:https':'node:http');t.get({host,port:Number(process.env.STORAGE_GATEWAY_LISTEN_PORT||8443),path:'/healthz',rejectUnauthorized:false,timeout:3000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
