#!/bin/sh
# Puts the platform's footer credit beside Ghost's own in every bundled theme
# (themes/footer-credit/README.md). Usage: apply.sh THEMES_DIR, the directory
# holding one directory per bundled theme. Each theme's patch adds one
# `{{> platform-footer-credit}}` call next to its Ghost credit, applied with no
# fuzz; the partial it calls is copied into the theme's partials/. Fails (non-zero,
# message on stderr) when a patch no longer applies, when a theme in
# THEMES_DIR has no patch, or when a patch names a theme that is not there, so a
# theme added or bumped without its footer is a failed build, not a footer
# without the credit.
set -eu

themes=${1:?usage: apply.sh THEMES_DIR}
here=$(cd "$(dirname "$0")" && pwd)

for patch_file in "$here"/*.patch; do
  theme=$(basename "$patch_file" .patch)
  dir=$themes/$theme
  if [ ! -d "$dir" ]; then
    echo "ERROR: $theme.patch names a theme that is not in $themes" >&2
    exit 1
  fi
  if ! (cd "$dir" && patch -s -F0 -p1 < "$patch_file"); then
    echo "ERROR: $theme.patch no longer applies cleanly to the $theme theme -- the pinned theme changed; re-derive its footer patch before rebuilding" >&2
    exit 1
  fi
  find "$dir" \( -name '*.orig' -o -name '*.rej' \) -delete
  mkdir -p "$dir/partials"
  cp "$here/platform-footer-credit.hbs" "$dir/partials/platform-footer-credit.hbs"
done

for dir in "$themes"/*/; do
  theme=$(basename "$dir")
  if [ ! -f "$here/$theme.patch" ]; then
    echo "ERROR: the $theme theme has no footer patch ($theme.patch) -- add one so it prints the platform's credit" >&2
    exit 1
  fi
done
