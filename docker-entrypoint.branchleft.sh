#!/bin/sh
# branchLeft entrypoint wrapper for Cloud Run. Translates Cloud Run's $PORT
# into Ghost's server__port/server__host env vars, then hands off to the
# upstream image's entrypoint, which still has to run first.
# See docker-entrypoint.branchleft.md#cloud-run-port-translation.
set -e

export server__port="${PORT:-2368}"
export server__host="${SERVER_HOST:-0.0.0.0}"

# --- Storage-adapter fail-closed guard --------------------------------------
# Refuses to boot into Ghost's server process unless every storage feature
# (images, media, files) is configured through the scanning decorator over a
# durable wrapped adapter with its required fields set. An unconfigured or
# bare adapter fails silently instead of loudly, which is why this is
# enforced at boot rather than only documented.
# See docker-entrypoint.branchleft.md#storage-adapter-fail-closed-guard.
check_storage_feature() {
    feature="$1"
    eval "adapter=\${storage__${feature}__adapter:-}"

    case "$adapter" in
        "")
            echo "FATAL: storage__${feature}__adapter is not set." >&2
            echo "Ghost defaults to local-disk storage (Local*Storage), which is silently" >&2
            echo "lost on every Cloud Run instance recycle, and even a durable adapter set" >&2
            echo "directly (storage__${feature}__adapter=S3Storage) is silently unscanned." >&2
            echo "Set storage__${feature}__adapter=ScanningStorageAdapter plus" >&2
            echo "storage__${feature}__wraps and the storage__${feature}__wrappedConfig__*" >&2
            echo "variables documented in adapters/scanning-storage/README.md for any" >&2
            echo "real deploy." >&2
            echo "" >&2
            echo "The local-development escape hatch (BRANCHLEFT_ALLOW_LOCAL_STORAGE=true)" >&2
            echo "does not waive this -- it only lets storage__${feature}__wraps name a" >&2
            echo "local adapter instead of S3Storage. Every kind still needs the decorator." >&2
            exit 1
            ;;
        ScanningStorageAdapter)
            : # checked below -- the wrapped adapter, not this name, decides durability.
            ;;
        *)
            echo "FATAL: storage__${feature}__adapter=${adapter} is not the scanning" >&2
            echo "decorator. A bare adapter -- durable or not -- is unscanned silently." >&2
            echo "Set storage__${feature}__adapter=ScanningStorageAdapter plus" >&2
            echo "storage__${feature}__wraps and the storage__${feature}__wrappedConfig__*" >&2
            echo "variables documented in adapters/scanning-storage/README.md for any" >&2
            echo "real deploy." >&2
            echo "" >&2
            echo "The local-development escape hatch (BRANCHLEFT_ALLOW_LOCAL_STORAGE=true)" >&2
            echo "does not waive this -- it only lets storage__${feature}__wraps name a" >&2
            echo "local adapter instead of S3Storage. Every kind still needs the decorator." >&2
            exit 1
            ;;
    esac

    eval "wraps=\${storage__${feature}__wraps:-}"

    if [ -z "$wraps" ]; then
        echo "FATAL: storage__${feature}__adapter=ScanningStorageAdapter but" >&2
        echo "storage__${feature}__wraps is not set -- the decorator has no adapter to" >&2
        echo "delegate to. See adapters/scanning-storage/README.md." >&2
        exit 1
    fi

    # Durability layer -- the one thing the local-development escape hatch
    # waives. Never reached for the decorator check above; a decorator
    # missing or misnamed on any feature refuses regardless of this switch.
    if [ "${BRANCHLEFT_ALLOW_LOCAL_STORAGE:-}" != "true" ]; then
        case "$wraps" in
            Local*Storage)
                echo "FATAL: storage__${feature}__wraps=${wraps} is a local-disk adapter." >&2
                echo "Local disk is not durable on Cloud Run -- uploaded media is lost" >&2
                echo "silently on the next instance recycle, decorator or not. Set" >&2
                echo "storage__${feature}__wraps=S3Storage plus the" >&2
                echo "storage__${feature}__wrappedConfig__* variables documented in" >&2
                echo "adapters/scanning-storage/README.md for any real deploy." >&2
                echo "" >&2
                echo "Local development / smoke tests only: set" >&2
                echo "BRANCHLEFT_ALLOW_LOCAL_STORAGE=true to bypass this check (the decorator" >&2
                echo "requirement above still applies)." >&2
                exit 1
                ;;
        esac

        # A wrapped adapter missing its required config only trades one
        # silent failure for another. Gated on $wraps, never on $adapter --
        # $adapter is always ScanningStorageAdapter by this point, so gating
        # on it here would silently skip this check for every real config.
        # See docker-entrypoint.branchleft.md#required-field-check-gating.
        if [ "$wraps" = "S3Storage" ]; then
            missing=""
            eval "v=\${storage__${feature}__wrappedConfig__bucket:-}"
            [ -z "$v" ] && missing="${missing} storage__${feature}__wrappedConfig__bucket"
            eval "v=\${storage__${feature}__wrappedConfig__staticFileURLPrefix:-}"
            [ -z "$v" ] && missing="${missing} storage__${feature}__wrappedConfig__staticFileURLPrefix"
            eval "v=\${storage__${feature}__wrappedConfig__cdnUrl:-}"
            [ -z "$v" ] && missing="${missing} storage__${feature}__wrappedConfig__cdnUrl"
            eval "v=\${storage__${feature}__wrappedConfig__multipartUploadThresholdBytes:-}"
            [ -z "$v" ] && missing="${missing} storage__${feature}__wrappedConfig__multipartUploadThresholdBytes"
            eval "v=\${storage__${feature}__wrappedConfig__multipartChunkSizeBytes:-}"
            [ -z "$v" ] && missing="${missing} storage__${feature}__wrappedConfig__multipartChunkSizeBytes"

            if [ -n "$missing" ]; then
                echo "FATAL: storage__${feature}__wraps=S3Storage but required config is missing:" >&2
                for var_name in $missing; do
                    echo "  - $var_name" >&2
                done
                echo "See adapters/scanning-storage/README.md's environment variable table" >&2
                echo "for what each one means." >&2
                exit 1
            fi
        fi
    fi
}

case "$*" in
    "node current/index.js"|"node "*"current/index.js"*)
        check_storage_feature images
        check_storage_feature media
        check_storage_feature files
        ;;
esac

exec docker-entrypoint.sh "$@"
