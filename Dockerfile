# branchLeft tenant Ghost image
#
# One image, identical for every tenant, configured entirely by environment
# variables at deploy time (see README.md for the full list). No secrets,
# no tenant-specific values, and no writable local disk assumptions for
# anything that must survive a restart — this image targets Cloud Run,
# which has no durable local storage.
#
# Base image pinned to an explicit version *and* digest (not `latest`, not
# a bare major tag) so a rebuild is reproducible and a base-image swap is
# always a visible, reviewed diff. Verified locally: `docker pull
# ghost:6.55.0-alpine` resolves to this digest as of 2026-08-04.
FROM ghost:6.55.0-alpine@sha256:de23ea18e09f1f6e94dd323c831c3821494fa054b7a55984a5bd0b817fcab918

# Ghost's built-in S3Storage adapter (core/server/adapters/storage/S3Storage.js)
# and its dependency, @aws-sdk/client-s3, already ship inside every official
# Ghost 6.x image — confirmed by inspecting this exact image's
# /var/lib/ghost/current tree (see README.md "Storage adapter" section for
# how that was verified). No package install or adapter registration step is
# needed here: activating it is pure configuration, via the storage__* env
# vars documented in the README. This is why there is no `npm install` /
# `pnpm add` line in this Dockerfile for storage support.

# Cloud Run entrypoint wrapper: translates the platform's $PORT into Ghost's
# server__port / server__host config before handing off to the upstream
# entrypoint. See docker-entrypoint.branchleft.sh for why this can't just be
# a CMD change.
COPY docker-entrypoint.branchleft.sh /usr/local/bin/docker-entrypoint.branchleft.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.branchleft.sh

ENTRYPOINT ["docker-entrypoint.branchleft.sh"]
CMD ["node", "current/index.js"]
