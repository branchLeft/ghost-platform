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
# server__port / server__host config, and refuses to start (fail closed)
# unless storage__images__adapter is the scanning decorator (below) wrapping
# a durable adapter with its required config present — Ghost's own compiled
# default is a bare local adapter, which is both silently lost on every
# Cloud Run instance recycle and silently unscanned. See
# docker-entrypoint.branchleft.sh for the full guard and its explicit
# local-dev escape hatch, and scripts/test-storage-guard.sh for the
# regression test proving both the blocked and permitted paths actually
# behave as intended.
# The break-glass SSO adapter (adapters/sso/README.md). It goes into Ghost's
# own internal adapters directory, never the bind-mounted content directory: a
# tenant can write to content, and Ghost would load an adapter from there.
# Inert until a tenant's config sets adapters__sso__active=BreakGlassSSO.
COPY --chown=node:node adapters/sso/src/BreakGlassSSO.js adapters/sso/src/break-glass.js /var/lib/ghost/current/core/server/adapters/sso/

# Ghost-core overlay (adapters/sso/ghost-core-overlay/README.md): one file,
# one change, so a break-glass login's session is durably saved before the
# response can reach a client. No copy of Ghost's file is committed: the
# baseline is the file already in the digest-pinned base image above, and
# our change is a patch applied to it here. The build fails if the patch no
# longer applies cleanly (a Ghost version bump changed those lines) or if the
# patched file is not byte-for-byte the one the pinned hash was taken from;
# re-deriving the patch is then a deliberate step, not automatic. `patch` is
# a build-time tool only: installed, used and removed in this one layer, and
# its output is hash-checked, so it never reaches the image.
COPY adapters/sso/ghost-core-overlay/apply-session-from-token-patch.sh adapters/sso/ghost-core-overlay/session-from-token.patch adapters/sso/ghost-core-overlay/session-from-token.patched.sha256 /tmp/session-from-token-overlay/
RUN apk add --no-cache patch \
    && /tmp/session-from-token-overlay/apply-session-from-token-patch.sh /var/lib/ghost/current/core/server/services/auth/session \
    && chown node:node /var/lib/ghost/current/core/server/services/auth/session/session-from-token.js \
    && apk del patch \
    && rm -rf /tmp/session-from-token-overlay

# Ghost-core overlay (adapters/stripe-connect-limit/ghost-core-overlay/README.md):
# one file, one change, so a demo slot cannot store a Stripe key by any route.
# Inert unless the host limit limitStripeConnect is set, so this one image
# still serves every tenant. Built like the layer above: the build fails if
# a Ghost version bump moved the patched lines, or the result differs from
# the pinned hash. `patch` is installed, used and removed in this one layer.
COPY adapters/ghost-core-overlay/apply-patch.sh adapters/stripe-connect-limit/ghost-core-overlay/stripe-connect-limit.patch adapters/stripe-connect-limit/ghost-core-overlay/stripe-connect-limit.patched.sha256 /tmp/stripe-connect-limit-overlay/
RUN apk add --no-cache patch \
    && /tmp/stripe-connect-limit-overlay/apply-patch.sh /var/lib/ghost/current/core/server/models settings.js /tmp/stripe-connect-limit-overlay/stripe-connect-limit.patch /tmp/stripe-connect-limit-overlay/stripe-connect-limit.patched.sha256 \
    && chown node:node /var/lib/ghost/current/core/server/models/settings.js \
    && apk del patch \
    && rm -rf /tmp/stripe-connect-limit-overlay

# The scanning storage decorator (adapters/scanning-storage/README.md). It
# goes into Ghost's own storage adapters directory, alongside the built-in
# LocalImagesStorage/LocalMediaStorage/LocalFilesStorage/S3Storage it wraps
# by name at construction time — resolving a sibling module the same way
# Ghost's own adapter manager resolves any adapter in this directory. It is
# inert until a tenant's config selects it for a storage feature
# (storage__images__adapter=ScanningStorageAdapter and so on).
COPY --chown=node:node adapters/scanning-storage/src/ /var/lib/ghost/current/core/server/adapters/storage/

# The theme gate (adapters/scanning-storage/ghost-core-overlay/README.md).
# Ghost writes an uploaded theme with a ThemeStorage it constructs itself, so
# no storage__* setting can put the decorator in front of it. Guard first,
# then move the upstream file aside and put a subclass that scans the whole
# tree through the images decorator in its place: if the upstream file has
# changed (a Ghost version bump) the build fails rather than wrapping a
# different class, and re-deriving the pin is a deliberate step.
COPY adapters/scanning-storage/ghost-core-overlay/theme-storage.upstream.sha256 /tmp/theme-storage.upstream.sha256
RUN cd /var/lib/ghost/current/core/server/services/themes \
    && sha256sum -c /tmp/theme-storage.upstream.sha256 \
    && mv theme-storage.js theme-storage.upstream.js \
    || (echo "ERROR: upstream Ghost core file theme-storage.js no longer matches the theme gate's pinned hash -- re-derive adapters/scanning-storage/ghost-core-overlay/ (see its README) before rebuilding" >&2 && exit 1)
COPY --chown=node:node adapters/scanning-storage/ghost-core-overlay/theme-storage.js /var/lib/ghost/current/core/server/services/themes/theme-storage.js

# The export colour's no-op scheduler (services/export-bundler/README.md). Ghost
# has no setting that stops its scheduler; this adapter is the off switch, and
# it is inert until a colour's config sets
# adapters__scheduling__active=SchedulingDisabled -- which only the export
# bundler's colour does. Internal adapters directory, never content: a tenant
# can write to content.
COPY --chown=node:node services/export-bundler/ghost-adapter/SchedulingDisabled.js services/export-bundler/ghost-adapter/scheduling-disabled.js /var/lib/ghost/current/core/server/adapters/scheduling/

# The image editor for the admin post editor (vendor/kalotyp/README.md): Kalotyp
# 0.2.6, MIT, vendored byte-for-byte. Guard first, copy second, as above: the
# build fails if either pinned hash no longer matches the vendored bytes. No
# network at build. Served from the admin app's own /assets path; the config
# keys that point Ghost at it are set elsewhere.
COPY vendor/kalotyp/kalotyp.sha256 vendor/kalotyp/kalotyp.js vendor/kalotyp/kalotyp.css /tmp/kalotyp/
RUN cd /tmp/kalotyp \
    && sha256sum -c kalotyp.sha256 \
    || (echo "ERROR: vendored Kalotyp no longer matches its pinned sha256 (vendor/kalotyp/kalotyp.sha256) -- re-vendor and re-pin it before rebuilding" >&2 && exit 1)
COPY --chown=node:node vendor/kalotyp/kalotyp.js vendor/kalotyp/kalotyp.css vendor/kalotyp/LICENSE /var/lib/ghost/current/core/built/admin/assets/kalotyp/
RUN rm -rf /tmp/kalotyp

# The bundled themes and the curated fonts (themes/README.md). Every Ghost-
# authored open-source theme without a technical blocker, each fetched at a
# full commit SHA and checked against a pinned content hash, with its licence
# file and copyright kept. The fonts are the open-licence set, fetched the same
# way and served from each theme's own assets/platform-fonts/, so a font is
# always a file on the tenant's origin. verify.mjs fails the build if a theme or
# font differs from its pin, lacks its licence, or references any outside
# origin. Casper and Source ship in the base image (digest-pinned above) and
# are checked in place. Fetching needs the network, like `apk add` above; the
# Node already in the base image runs it and nothing is installed. Seeded into
# the content directory by the base image's entrypoint, theme by theme.
COPY themes/fetch.mjs themes/verify.mjs themes/manifest.json /tmp/themes/
COPY themes/lib/ /tmp/themes/lib/
RUN set -e \
    && node /tmp/themes/fetch.mjs --out /tmp/themes-bundle \
    && node /tmp/themes/verify.mjs --bundle /tmp/themes-bundle --base-themes /var/lib/ghost/current/content/themes \
    && cp -R /tmp/themes-bundle/themes/. /var/lib/ghost/content.orig/themes/ \
    && for theme in /var/lib/ghost/content.orig/themes/*; do \
         mkdir -p "$theme/assets/platform-fonts" \
         && cp -R /tmp/themes-bundle/fonts/. "$theme/assets/platform-fonts/" \
         && chown -R node:node "$theme/"; \
       done \
    && rm -rf /tmp/themes /tmp/themes-bundle

COPY docker-entrypoint.branchleft.sh /usr/local/bin/docker-entrypoint.branchleft.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.branchleft.sh

ENTRYPOINT ["docker-entrypoint.branchleft.sh"]
CMD ["node", "current/index.js"]
