#!/bin/sh
# Applies session-from-token.patch to Ghost's own session-from-token.js in the
# directory given, then checks the result against session-from-token.patched.sha256.
# Fails (non-zero, message on stderr) when the patch does not apply cleanly or the
# result is not exactly the file the pin was taken from. The image build and the
# unit tests both call this, so there is one home for the rule.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
dir=${1:?usage: apply-session-from-token-patch.sh DIR}

cd "$dir"

if ! patch -s -F0 session-from-token.js < "$here/session-from-token.patch"; then
  echo "ERROR: session-from-token.patch no longer applies cleanly to Ghost's session-from-token.js -- upstream changed the file; re-derive the patch (adapters/sso/ghost-core-overlay/README.md) before rebuilding" >&2
  exit 1
fi
rm -f session-from-token.js.orig session-from-token.js.rej

if command -v sha256sum >/dev/null 2>&1; then
  sum_ok=0
  sha256sum -c "$here/session-from-token.patched.sha256" || sum_ok=1
else
  sum_ok=0
  shasum -a 256 -c "$here/session-from-token.patched.sha256" || sum_ok=1
fi

if [ "$sum_ok" -ne 0 ]; then
  echo "ERROR: the patched session-from-token.js does not match session-from-token.patched.sha256 -- upstream changed the file outside the patch's lines; re-derive the patch and the pin (adapters/sso/ghost-core-overlay/README.md) before rebuilding" >&2
  exit 1
fi
