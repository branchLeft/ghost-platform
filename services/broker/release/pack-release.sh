#!/usr/bin/env bash
# Packs the broker bundle (the output of `pnpm run bundle`: broker.mjs and
# plugins/*.mjs) into the release tarball and its sha256 file.
#
# Usage: pack-release.sh <bundle_dir> <version> <out_dir>
#
# Writes, into <out_dir>:
#   broker-bundle-<version>.tar.gz
#   broker-bundle-<version>.tar.gz.sha256   (sha256sum format, bare file name)
#
# The tarball is deterministic: the same bundle contents always give the same
# bytes, whatever the file times, the owner or the order the files were
# written in. That is what lets a reviewed digest in another repo pin a
# release, and what lets a pull request prove the packing without a tag.
# Members are the bundle's contents with no leading directory, so they unpack
# straight into a release directory.
#
# GNU tar is required (the `--sort`, `--mtime` and `--owner` flags below);
# the script refuses to run with any other tar rather than pack differently.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <bundle_dir> <version> <out_dir>" >&2
  exit 2
fi

bundle_dir="$1"
version="$2"
out_dir="$3"

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "refusing: version '${version}' is not MAJOR.MINOR.PATCH" >&2
  exit 1
fi

if [ ! -f "${bundle_dir}/broker.mjs" ]; then
  echo "refusing: ${bundle_dir}/broker.mjs does not exist; run 'pnpm run bundle' first" >&2
  exit 1
fi

if ! tar --version 2>/dev/null | head -n 1 | grep -q 'GNU tar'; then
  echo "refusing: GNU tar is required for a deterministic tarball" >&2
  exit 1
fi

mkdir -p "$out_dir"
tarball="broker-bundle-${version}.tar.gz"

list="$(mktemp)"
trap 'rm -f "$list"' EXIT

# An explicit, byte-ordered member list: no `./` prefix, and no dependence on
# directory read order.
(cd "$bundle_dir" && find . -mindepth 1 | sed 's|^\./||' | LC_ALL=C sort) >"$list"

# `--mode` fixes the permission bits so a different umask on the building host
# cannot change the bytes; `gzip -n` leaves out the file name and time.
tar --create --file - \
  --directory "$bundle_dir" \
  --no-recursion \
  --files-from "$list" \
  --format=gnu \
  --sort=name \
  --mtime=@0 \
  --owner=0 --group=0 --numeric-owner \
  --mode='u+rw,go-w,a+rX' \
  | gzip -n -9 >"${out_dir}/${tarball}"

(cd "$out_dir" && sha256sum "$tarball" >"${tarball}.sha256")

echo "packed ${out_dir}/${tarball}"
