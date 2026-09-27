#!/bin/sh
# branchLeft entrypoint wrapper for Cloud Run.
#
# Cloud Run injects the port to listen on via the $PORT environment variable
# (defaulting to 8080 if unset, per Cloud Run's contract) and requires the
# container to bind all interfaces. Ghost has no native concept of $PORT —
# it reads server.port / server.host through nconf — so this wrapper
# translates Cloud Run's convention into Ghost's own env-var config keys
# (server__port, server__host; see README.md for the full nconf/env-var
# mapping) before handing off to the upstream image's entrypoint.
#
# The upstream entrypoint (docker-entrypoint.sh, shipped by the base
# ghost:6.55.0-alpine image) still needs to run first: it steps down from
# root to the "node" user via gosu, and seeds the (always-empty, since
# Cloud Run has no durable volume) content directory from content.orig on
# every boot — that seeding is what puts the default Casper theme and
# fixture settings in place. We don't reimplement that; we just set env
# vars and exec into it.
set -e

export server__port="${PORT:-2368}"
export server__host="${SERVER_HOST:-0.0.0.0}"

# --- Storage-adapter fail-closed guard --------------------------------------
#
# Ghost's compiled defaults (ghost/core/core/shared/config/defaults.json)
# are storage.active=LocalImagesStorage, with LocalMediaStorage/
# LocalFilesStorage for the media/files features — local disk. On Cloud Run,
# local disk is not durable: anything written there is not guaranteed to
# survive an instance recycle (autoscale, redeploy, crash). If storage__*
# is left unconfigured, none of that fails loudly — the container boots
# cleanly, the site serves fine, an editor's upload appears to work, and the
# file is silently gone the next time the instance cycles. No error, no log
# line, no alert. That combination — confidently wrong, not loudly wrong —
# makes it the platform's single most dangerous failure mode, so it's
# refused at boot here rather than merely documented in the README.
#
# Durability is no longer the only property this guard protects.
# adapters/scanning-storage/README.md's decorator is the only path a byte
# can reach a served location through and still be scanned, so a bare
# `S3Storage` boots durably but unscanned, silently, with every other check
# here passing. The guard therefore refuses any
# configuration whose `images` feature is not the decorator itself, and
# checks the *wrapped* adapter's own required fields (`storage__images__wraps`
# / `storage__images__wrappedConfig__*`) rather than trusting a bare adapter
# name the way it used to. Checked on the `images` feature only, mirroring
# what render-core actually needs to boot first-run user creation
# (`core/server/models/user.js`'s gravatar lookup resolves `storage:images`)
# — `media`/`files` are rendered by render-core too, but are not this boot
# guard's job to police individually.
#
# Only runs when we're actually about to start Ghost's server process
# (mirrors the same "$*" pattern check the upstream entrypoint itself uses
# before doing its root-step-down/content-reseed work) — `docker run
# <image> sh` for debugging isn't blocked by this.
#
# Escape hatch, local development / the SQLite smoke test only:
# BRANCHLEFT_ALLOW_LOCAL_STORAGE=true. Deliberately just an explicit env var
# — never inferred from NODE_ENV, and never inferred from the presence or
# absence of Cloud Run's own K_SERVICE variable. "We couldn't detect Cloud
# Run" is not evidence a deploy is safe; a heuristic here would eventually
# be wrong in the direction that matters (a real tenant silently allowed
# through), so the guard would rather annoy a developer than trust an
# inference.
case "$*" in
    "node current/index.js"|"node "*"current/index.js"*)
        if [ "${BRANCHLEFT_ALLOW_LOCAL_STORAGE:-}" != "true" ]; then
            case "${storage__images__adapter:-}" in
                "")
                    echo "FATAL: storage__images__adapter is not set." >&2
                    echo "Ghost defaults to local-disk storage (LocalImagesStorage), which is" >&2
                    echo "silently lost on every Cloud Run instance recycle, and even a durable" >&2
                    echo "adapter set directly (storage__images__adapter=S3Storage) is silently" >&2
                    echo "unscanned. Set storage__images__adapter=ScanningStorageAdapter plus" >&2
                    echo "storage__images__wraps and the storage__images__wrappedConfig__*" >&2
                    echo "variables documented in adapters/scanning-storage/README.md for any" >&2
                    echo "real deploy." >&2
                    echo "" >&2
                    echo "Local development / smoke tests only: set" >&2
                    echo "BRANCHLEFT_ALLOW_LOCAL_STORAGE=true to bypass this check." >&2
                    exit 1
                    ;;
                ScanningStorageAdapter)
                    : # checked below -- the wrapped adapter, not this name, decides durability.
                    ;;
                *)
                    echo "FATAL: storage__images__adapter=${storage__images__adapter} is not the" >&2
                    echo "scanning decorator. A bare adapter -- durable or not -- is unscanned" >&2
                    echo "silently. Set storage__images__adapter=ScanningStorageAdapter" >&2
                    echo "plus storage__images__wraps and the storage__images__wrappedConfig__*" >&2
                    echo "variables documented in adapters/scanning-storage/README.md for any" >&2
                    echo "real deploy." >&2
                    echo "" >&2
                    echo "Local development / smoke tests only: set" >&2
                    echo "BRANCHLEFT_ALLOW_LOCAL_STORAGE=true to bypass this check." >&2
                    exit 1
                    ;;
            esac

            case "${storage__images__wraps:-}" in
                "")
                    echo "FATAL: storage__images__adapter=ScanningStorageAdapter but" >&2
                    echo "storage__images__wraps is not set -- the decorator has no adapter to" >&2
                    echo "delegate to. See adapters/scanning-storage/README.md." >&2
                    exit 1
                    ;;
                Local*Storage)
                    echo "FATAL: storage__images__wraps=${storage__images__wraps} is a local-disk" >&2
                    echo "adapter. Local disk is not durable on Cloud Run -- uploaded media is" >&2
                    echo "lost silently on the next instance recycle, decorator or not. Set" >&2
                    echo "storage__images__wraps=S3Storage plus the" >&2
                    echo "storage__images__wrappedConfig__* variables documented in" >&2
                    echo "adapters/scanning-storage/README.md for any real deploy." >&2
                    echo "" >&2
                    echo "Local development / smoke tests only: set" >&2
                    echo "BRANCHLEFT_ALLOW_LOCAL_STORAGE=true to bypass this check." >&2
                    exit 1
                    ;;
            esac

            # A non-local wrapped adapter configured without the config a
            # working upload actually needs is only marginally better than a
            # local one -- it just moves the silent failure from "media is
            # lost on recycle" to "media never uploaded in the first place"
            # (or an opaque runtime error the first time someone tries).
            # Check the required S3Storage fields specifically, since that's
            # the adapter this image is built around; a future non-default
            # wrapped adapter would need its own equivalent check added here.
            if [ "${storage__images__wraps}" = "S3Storage" ]; then
                missing=""
                if [ -z "${storage__images__wrappedConfig__bucket:-}" ]; then
                    missing="${missing} storage__images__wrappedConfig__bucket"
                fi
                if [ -z "${storage__images__wrappedConfig__staticFileURLPrefix:-}" ]; then
                    missing="${missing} storage__images__wrappedConfig__staticFileURLPrefix"
                fi
                if [ -z "${storage__images__wrappedConfig__cdnUrl:-}" ]; then
                    missing="${missing} storage__images__wrappedConfig__cdnUrl"
                fi
                if [ -z "${storage__images__wrappedConfig__multipartUploadThresholdBytes:-}" ]; then
                    missing="${missing} storage__images__wrappedConfig__multipartUploadThresholdBytes"
                fi
                if [ -z "${storage__images__wrappedConfig__multipartChunkSizeBytes:-}" ]; then
                    missing="${missing} storage__images__wrappedConfig__multipartChunkSizeBytes"
                fi

                if [ -n "$missing" ]; then
                    echo "FATAL: storage__images__wraps=S3Storage but required config is missing:" >&2
                    for var_name in $missing; do
                        echo "  - $var_name" >&2
                    done
                    echo "See adapters/scanning-storage/README.md's environment variable table" >&2
                    echo "for what each one means." >&2
                    exit 1
                fi
            fi
        fi
        ;;
esac

exec docker-entrypoint.sh "$@"
