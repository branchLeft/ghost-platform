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
            case "${storage__active:-}" in
                "")
                    echo "FATAL: storage__active is not set." >&2
                    echo "Ghost defaults to local-disk storage (LocalImagesStorage /" >&2
                    echo "LocalMediaStorage / LocalFilesStorage), which is silently lost on" >&2
                    echo "every Cloud Run instance recycle -- no error, no warning, just gone" >&2
                    echo "media. Set storage__active=S3Storage plus the storage__S3Storage__*" >&2
                    echo "variables documented in README.md for any real deploy." >&2
                    echo "" >&2
                    echo "Local development / smoke tests only: set" >&2
                    echo "BRANCHLEFT_ALLOW_LOCAL_STORAGE=true to bypass this check." >&2
                    exit 1
                    ;;
                Local*Storage)
                    echo "FATAL: storage__active=${storage__active} is a local-disk adapter." >&2
                    echo "Local disk is not durable on Cloud Run -- uploaded media is lost" >&2
                    echo "silently on the next instance recycle. Set" >&2
                    echo "storage__active=S3Storage plus the storage__S3Storage__* variables" >&2
                    echo "documented in README.md for any real deploy." >&2
                    echo "" >&2
                    echo "Local development / smoke tests only: set" >&2
                    echo "BRANCHLEFT_ALLOW_LOCAL_STORAGE=true to bypass this check." >&2
                    exit 1
                    ;;
            esac

            # A non-local adapter configured without the config a working
            # upload actually needs is only marginally better than a local
            # one -- it just moves the silent failure from "media is lost on
            # recycle" to "media never uploaded in the first place" (or an
            # opaque runtime error the first time someone tries). Check the
            # required S3Storage fields specifically, since that's the
            # adapter this image is built around; a future non-default
            # adapter would need its own equivalent check added here.
            if [ "${storage__active}" = "S3Storage" ]; then
                missing=""
                if [ -z "${storage__S3Storage__bucket:-}" ]; then
                    missing="${missing} storage__S3Storage__bucket"
                fi
                if [ -z "${storage__S3Storage__staticFileURLPrefix:-}" ]; then
                    missing="${missing} storage__S3Storage__staticFileURLPrefix"
                fi
                if [ -z "${storage__S3Storage__cdnUrl:-}" ]; then
                    missing="${missing} storage__S3Storage__cdnUrl"
                fi
                if [ -z "${storage__S3Storage__multipartUploadThresholdBytes:-}" ]; then
                    missing="${missing} storage__S3Storage__multipartUploadThresholdBytes"
                fi
                if [ -z "${storage__S3Storage__multipartChunkSizeBytes:-}" ]; then
                    missing="${missing} storage__S3Storage__multipartChunkSizeBytes"
                fi

                if [ -n "$missing" ]; then
                    echo "FATAL: storage__active=S3Storage but required config is missing:" >&2
                    for var_name in $missing; do
                        echo "  - $var_name" >&2
                    done
                    echo "See README.md's environment variable table for what each one means." >&2
                    exit 1
                fi
            fi
        fi
        ;;
esac

exec docker-entrypoint.sh "$@"
