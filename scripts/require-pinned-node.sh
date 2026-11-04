#!/bin/sh
# Runs its arguments only under the Node the repository pins (.nvmrc), compared by major
# version. pnpm crashes under an older Node before it reaches the tool it runs, so a commit hook
# under the wrong Node would die with a stack trace instead of saying what is wrong. This stops
# with one line naming the Node needed. It does not select a Node: how one is chosen (nvm, fnm,
# PATH) is the caller's.
#
# Usage: scripts/require-pinned-node.sh <command> [args...]
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
pinned=$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$root/.nvmrc")
have=$(node --version 2>/dev/null) || have=none

pinned_major=${pinned#v}
pinned_major=${pinned_major%%.*}
have_major=${have#v}
have_major=${have_major%%.*}

if [ "$have_major" != "$pinned_major" ]; then
  echo "this hook needs Node $pinned (from .nvmrc), found $have: put that Node first on PATH and commit again" >&2
  exit 1
fi

exec "$@"
