#!/bin/sh
# Proves the placeholder probe refuses what it should, against a stub gh on PATH,
# so no network or attestation is needed. The stub reads its behaviour from
# files beside it, because the probe runs gh under a scrubbed environment that
# drops this test's variables. The caller exports GH_TOKEN and GITHUB_TOKEN as
# stand-ins for real credentials, so a probe that did not scrub them would let
# them reach the stub. Like the real gh, the stub refuses to run with no
# GH_TOKEN at all, so a probe that dropped the placeholder goes red.
#
# Usage:
#   ./scripts/test-probe-tokenless-attestation.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/probe-tokenless-attestation.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/bin"

PROBE_RETRY_WAIT=0
export PROBE_RETRY_WAIT
GH_TOKEN=x
GITHUB_TOKEN=y
export GH_TOKEN GITHUB_TOKEN
PATH="$WORK/bin:$PATH"
export PATH

cat > "$WORK/bin/gh" <<'STUB'
#!/bin/sh
# Stub gh. Modes: needs-token, accept-all, fault-forged, identity, api-call.
DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="$(cat "$DIR/mode")"
REAL="$(cat "$DIR/real")"
if [ -n "${GITHUB_TOKEN:-}" ] || { [ -n "${GH_TOKEN:-}" ] && [ "$GH_TOKEN" != placeholder-not-a-credential ]; }; then
  echo "env: token-visible" >> "$DIR/calls.log"
elif [ -n "${GH_TOKEN:-}" ]; then
  echo "env: placeholder" >> "$DIR/calls.log"
else
  echo "env: no-token" >> "$DIR/calls.log"
fi
# The real gh will not start with no token at all.
if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] || [ "$MODE" = needs-token ]; then
  echo "To get started with GitHub CLI, please run:  gh auth login" >&2
  exit 1
fi
# Debug output names TUF, as the real gh does; it must never decide a verdict.
case "${GH_DEBUG:-0}" in
  0 | '') ;;
  *)
    echo '* Request to https://tuf-repo-cdn.sigstore.dev/15.root.json' >&2
    if [ "$MODE" = api-call ]; then
      echo '* Request to https://api.github.com/user' >&2
    fi
    ;;
esac
# A real token in the environment makes this stub accept anything, as a
# token-backed gh would. A leaked token therefore shows as an accepted forgery.
if [ -n "${GITHUB_TOKEN:-}" ] || [ "$GH_TOKEN" != placeholder-not-a-credential ]; then
  exit 0
fi
if [ "$MODE" = accept-all ]; then
  exit 0
fi
image=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    oci://*) image="${1#oci://}" ;;
  esac
  shift
done
if [ "$image" = "$REAL" ]; then
  exit 0
fi
if [ "$MODE" = fault-forged ]; then
  echo 'Get "https://ghcr.io/v2/branchleft/portal-apps/manifests/sha256": dial tcp: lookup ghcr.io: no such host' >&2
  exit 1
fi
echo "Error: Policy verification failed: no matching CertificateIdentity found, last error: Subject Alternative Name must match regex" >&2
exit 1
STUB
chmod +x "$WORK/bin/gh"

REAL="ghcr.io/branchleft/ghost-tenant@sha256:$(printf '%064d' 0 | tr 0 a)"
FORGED="ghcr.io/branchleft/portal-apps@sha256:$(printf '%064d' 0 | tr 0 b)"
printf '%s\n' "$REAL" > "$WORK/bin/real"
OUT="$WORK/out.txt"

FAILED=0

# expect_fail MODE TEXT: the probe must exit non-zero and print TEXT.
expect_fail() {
  printf '%s\n' "$1" > "$WORK/bin/mode"
  : > "$WORK/bin/calls.log"
  if "$PROBE" "$REAL" "$FORGED" > "$OUT" 2>&1; then
    echo "FAIL [$1]: the probe passed, expected: $2"
    sed 's/^/    /' "$OUT"
    FAILED=1
    return
  fi
  if ! grep -Fq "$2" "$OUT"; then
    echo "FAIL [$1]: expected: $2"
    sed 's/^/    /' "$OUT"
    FAILED=1
    return
  fi
  echo "ok   [$1]: $2"
}

expect_fail needs-token "ASSERT FAILED: verification needs a GitHub token"
expect_fail accept-all "ASSERT FAILED: forged digest accepted: the probe is vacuous"
expect_fail fault-forged "ASSERT FAILED: forged digest refused by a fault, not by identity"

# The green case: the real digest verifies, the forged one is refused for identity,
# the stub only ever saw the placeholder, and debug text did not decide a verdict.
printf '%s\n' identity > "$WORK/bin/mode"
: > "$WORK/bin/calls.log"
if ! "$PROBE" "$REAL" "$FORGED" > "$OUT" 2>&1; then
  echo "FAIL [identity]: the probe failed, expected a pass:"
  sed 's/^/    /' "$OUT"
  FAILED=1
elif ! grep -Fq 'VERIFIED with a placeholder GH_TOKEN; no GitHub API call observed' "$OUT" \
  || ! grep -Fq 'refused for its identity' "$OUT" \
  || ! grep -Fq 'GH_TOKEN: the literal placeholder' "$OUT" \
  || ! grep -Fq 'requests logged to api.github.com: 0' "$OUT" \
  || ! grep -Fq 'tuf-repo-cdn.sigstore.dev' "$OUT"; then
  echo "FAIL [identity]: the pass did not print its results:"
  sed 's/^/    /' "$OUT"
  FAILED=1
elif grep -Fq 'with no token' "$OUT" || grep -Fq 'TOKENLESS' "$OUT"; then
  echo "FAIL [identity]: the output claims no token was used:"
  sed 's/^/    /' "$OUT"
  FAILED=1
elif grep -Fq 'token-visible' "$WORK/bin/calls.log" || grep -Fq 'no-token' "$WORK/bin/calls.log"; then
  echo "FAIL [identity]: gh saw something other than the placeholder:"
  sed 's/^/    /' "$WORK/bin/calls.log"
  FAILED=1
else
  echo "ok   [identity]: real digest verified and forged digest refused for its identity, on the placeholder only"
fi

# An API call in the debug log is reported, never hidden behind the green wording.
printf '%s\n' api-call > "$WORK/bin/mode"
if ! "$PROBE" "$REAL" "$FORGED" > "$OUT" 2>&1; then
  echo "FAIL [api-call]: the probe failed, expected a pass:"
  sed 's/^/    /' "$OUT"
  FAILED=1
elif grep -Fq 'no GitHub API call observed' "$OUT" || ! grep -Fq '1 GitHub API calls observed' "$OUT"; then
  echo "FAIL [api-call]: the API call was not reported:"
  sed 's/^/    /' "$OUT"
  FAILED=1
else
  echo "ok   [api-call]: a logged GitHub API call is reported, not claimed away"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "probe test FAILED"
  exit 1
fi
echo "probe test passed"
