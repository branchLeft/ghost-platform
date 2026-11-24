#!/bin/sh
# branchLeft entrypoint wrapper. Translates the platform's $PORT
# into Ghost's server__port/server__host env vars, then hands off to the
# upstream image's entrypoint, which still has to run first.
# See docker-entrypoint.branchleft.md#port-translation.
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
            echo "lost whenever the container is replaced, and even a durable adapter set" >&2
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
                echo "Local disk is not durable -- uploaded media is lost" >&2
                echo "silently when the container is next replaced, decorator or not. Set" >&2
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

# --- Bundled-theme refresh --------------------------------------------------
# The upstream entrypoint seeds a bundled theme into the content volume only
# when that theme directory is absent, so a site whose volume already holds an
# older copy keeps it and shows no platform footer credit
# (themes/footer-credit/README.md). Replace such a copy with the image's own,
# which is the copy a new site is seeded with. A copy that already carries the
# credit partial is left alone, and a theme the image does not bundle is never
# touched. A copy is replaced only while its files still match the pinned,
# unpatched bundle hash (themes/manifest.json treeSha256, written into the image
# as bundled-theme-pins.txt): a copy the tenant has changed is left as it is.
# The new copy is staged beside the old one and renamed into place, so a failed
# copy never leaves a half-written live theme, and the replaced copy is moved
# aside into the content directory, not deleted. A failure prints a warning and
# leaves the old theme live; it never stops Ghost from starting.
# See docker-entrypoint.branchleft.md#bundled-theme-refresh.

# sha256 of stdin as hex: sha256sum in the image, shasum on a macOS host.
sha256_hex() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | cut -d' ' -f1
    else
        shasum -a 256 | cut -d' ' -f1
    fi
}

# The content hash themes/lib/treehash.mjs computes, in POSIX sh: sha256 of the
# sorted "<sha256 of file>  <path>" lines (a symlink as "link:<target>  <path>").
tree_sha256() {
    (
        cd "$1" || exit 1
        find . \( -type f -o -type l \) | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r rel; do
            if [ -L "$rel" ]; then
                printf 'link:%s  %s\n' "$(readlink "$rel")" "$rel"
            else
                printf '%s  %s\n' "$(sha256_hex < "$rel")" "$rel"
            fi
        done | sha256_hex
    )
}

refresh_bundled_themes() {
    content="${GHOST_CONTENT:-/var/lib/ghost/content}"
    install_dir="${GHOST_INSTALL:-/var/lib/ghost}"
    seed_themes="$install_dir/content.orig/themes"
    pins="$install_dir/bundled-theme-pins.txt"
    site_themes="$content/themes"
    backup="$content/theme-backup-pre-footer-credit"
    partial="partials/platform-footer-credit.hbs"

    [ -d "$seed_themes" ] || return 0
    for src in "$seed_themes"/*; do
        [ -d "$src" ] || continue
        name=$(basename "$src")
        target="$site_themes/$name"
        # Only a real directory is refreshed: a symlink (the base image's own
        # themes) is already the patched copy, and an absent theme is seeded
        # by the upstream entrypoint itself.
        [ -d "$target" ] && [ ! -L "$target" ] || continue
        # Never replace a copy with one that lacks the credit.
        [ -e "$src/$partial" ] || continue
        [ -e "$target/$partial" ] && continue

        # Only an unmodified bundled copy is replaced: its files must hash to
        # the pinned, unpatched bundle. Anything else is the tenant's own.
        pin=$(awk -v n="$name" '$1 == n { print $2; exit }' "$pins" 2>/dev/null) || pin=""
        if [ -z "$pin" ] || [ "$(tree_sha256 "$target")" != "$pin" ]; then
            echo "left bundled theme $name untouched: it does not match the pinned bundle (tenant-changed or unknown), so it keeps its credit gap" >&2
            continue
        fi

        owner=""
        if [ "$(id -u)" = '0' ]; then
            owner=$(stat -c '%u:%g' "$target")
        fi
        staged="$site_themes/.$name.refresh-$$"
        rm -rf "$staged"
        if ! { cp -RL "$src" "$staged" && { [ -z "$owner" ] || chown -R "$owner" "$staged"; }; }; then
            rm -rf "$staged"
            echo "WARNING: could not copy bundled theme $name; the previous copy stays live" >&2
            continue
        fi
        stamp=$(date -u +%Y%m%dT%H%M%SZ)
        if ! mkdir -p "$backup" || ! mv "$target" "$backup/$name.$stamp"; then
            rm -rf "$staged"
            echo "WARNING: could not move the previous $name theme aside; it stays live" >&2
            continue
        fi
        if ! mv "$staged" "$target"; then
            mv "$backup/$name.$stamp" "$target" 2>/dev/null || true
            rm -rf "$staged"
            echo "WARNING: could not put bundled theme $name in place; the previous copy stays live" >&2
            continue
        fi
        echo "refreshed bundled theme $name (previous copy kept in $backup)" >&2
    done
    return 0
}

case "$*" in
    "node current/index.js"|"node "*"current/index.js"*)
        check_storage_feature images
        check_storage_feature media
        check_storage_feature files
        refresh_bundled_themes
        ;;
esac

exec docker-entrypoint.sh "$@"
