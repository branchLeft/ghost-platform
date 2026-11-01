#!/usr/bin/env bash
# Proves pack-release.sh is deterministic and lays the tarball out as the
# release contract says. Runs in broker-ci.yml; needs GNU tar (ubuntu).
#
# The two packs differ in everything a build could vary -- file times, the
# order the files were created in -- and must still give the same bytes. Drop
# `--mtime` from pack-release.sh and the digest comparison below goes red.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT

make_bundle() {
  local dir="$1"
  mkdir -p "${dir}/plugins"
  shift
  local name
  for name in "$@"; do
    printf 'export const name = "%s";\n' "$name" >"${dir}/${name}"
  done
}

make_bundle "${work}/bundle-a" broker.mjs plugins/one.mjs plugins/two.mjs
touch -d '2001-02-03 04:05:06 UTC' "${work}"/bundle-a/broker.mjs "${work}"/bundle-a/plugins/*.mjs

# Same contents, created in the opposite order, with different times.
make_bundle "${work}/bundle-b" plugins/two.mjs plugins/one.mjs broker.mjs
touch -d '2024-11-12 13:14:15 UTC' "${work}"/bundle-b/broker.mjs "${work}"/bundle-b/plugins/*.mjs

bash "${here}/pack-release.sh" "${work}/bundle-a" 1.2.3 "${work}/out-a" >/dev/null
bash "${here}/pack-release.sh" "${work}/bundle-b" 1.2.3 "${work}/out-b" >/dev/null

tarball="broker-bundle-1.2.3.tar.gz"
digest_a="$(sha256sum "${work}/out-a/${tarball}" | cut -d' ' -f1)"
digest_b="$(sha256sum "${work}/out-b/${tarball}" | cut -d' ' -f1)"
if [ "$digest_a" != "$digest_b" ]; then
  echo "FAIL: the same bundle packed twice gave different tarballs (${digest_a} vs ${digest_b})" >&2
  exit 1
fi

# The .sha256 file names the bare tarball and matches it.
(cd "${work}/out-a" && sha256sum --check --strict "${tarball}.sha256" >/dev/null)
if [ "$(cut -d' ' -f1 "${work}/out-a/${tarball}.sha256")" != "$digest_a" ]; then
  echo "FAIL: the .sha256 file does not carry the tarball digest" >&2
  exit 1
fi

# Members are the bundle's contents, with no leading directory.
members="$(tar --list --file "${work}/out-a/${tarball}")"
expected="$(printf 'broker.mjs\nplugins/\nplugins/one.mjs\nplugins/two.mjs\n')"
if [ "$members" != "$expected" ]; then
  echo "FAIL: unexpected tarball members:" >&2
  echo "$members" >&2
  exit 1
fi

# Owner and time are fixed.
listing="$(tar --list --verbose --numeric-owner --file "${work}/out-a/${tarball}" broker.mjs)"
case "$listing" in
  *" 0/0 "*"1970-01-01"*) ;;
  *)
    echo "FAIL: owner or time not normalised: ${listing}" >&2
    exit 1
    ;;
esac

# A different bundle must give a different tarball (the digest is not constant).
printf 'export const name = "changed";\n' >"${work}/bundle-b/broker.mjs"
bash "${here}/pack-release.sh" "${work}/bundle-b" 1.2.3 "${work}/out-c" >/dev/null
digest_c="$(sha256sum "${work}/out-c/${tarball}" | cut -d' ' -f1)"
if [ "$digest_c" = "$digest_a" ]; then
  echo "FAIL: a changed bundle packed to the same digest" >&2
  exit 1
fi

# A version that is not MAJOR.MINOR.PATCH is refused.
if bash "${here}/pack-release.sh" "${work}/bundle-a" 1.2 "${work}/out-d" >/dev/null 2>&1; then
  echo "FAIL: a malformed version was accepted" >&2
  exit 1
fi

echo "pack-release: ok"
