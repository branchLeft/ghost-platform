#!/bin/sh
# Applies PATCH to FILE inside DIR with no fuzz, then checks FILE against PIN
# (a sha256sum line naming FILE). Fails (non-zero, message on stderr) when the
# patch does not apply cleanly or the result is not exactly the file the pin
# was taken from. The root Dockerfile runs it for every Ghost-core overlay
# layer; the sso unit tests also run it directly, against the break-glass patch.
# PATCH and PIN are paths; FILE is relative to DIR.
set -eu

dir=${1:?usage: apply-patch.sh DIR FILE PATCH PIN}
file=${2:?usage: apply-patch.sh DIR FILE PATCH PIN}
patch_file=${3:?usage: apply-patch.sh DIR FILE PATCH PIN}
pin=${4:?usage: apply-patch.sh DIR FILE PATCH PIN}

# Resolve the two paths before changing directory, so a relative path means
# relative to where the caller stood.
patch_abs=$(cd "$(dirname "$patch_file")" && pwd)/$(basename "$patch_file")
pin_abs=$(cd "$(dirname "$pin")" && pwd)/$(basename "$pin")

cd "$dir"

if ! patch -s -F0 "$file" < "$patch_abs"; then
  echo "ERROR: $(basename "$patch_abs") no longer applies cleanly to Ghost's $file -- upstream changed the file; re-derive the patch before rebuilding" >&2
  exit 1
fi
rm -f "$file.orig" "$file.rej"

if command -v sha256sum >/dev/null 2>&1; then
  sum_ok=0
  sha256sum -c "$pin_abs" || sum_ok=1
else
  sum_ok=0
  shasum -a 256 -c "$pin_abs" || sum_ok=1
fi

if [ "$sum_ok" -ne 0 ]; then
  echo "ERROR: the patched $file does not match $(basename "$pin_abs") -- upstream changed the file outside the patch's lines; re-derive the patch and the pin before rebuilding" >&2
  exit 1
fi
