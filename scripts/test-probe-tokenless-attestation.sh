#!/bin/sh
# Proves the token-less probe refuses what it should, against a stub gh on PATH,
# so no network or attestation is needed. The stub reads its behaviour from
# files beside it, because the probe runs gh under a scrubbed environment that
# drops this test's variables. The caller exports GH_TOKEN and GITHUB_TOKEN, so
# a probe that did not scrub them would let them reach the stub.
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
# Stub gh. Modes: needs-token, accept-all, fault-forged, identity, auth-visible.
DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="$(cat "$DIR/mode")"
REAL="$(cat "$DIR/real")"
if [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  echo "env: token-visible" >> "$DIR/calls.log"
else
  echo "env: no-token" >> "$DIR/calls.log"
fi
if [ "$1" = auth ]; then
  if [ "$MODE" = auth-visible ]; then
    exit 0
  fi
  echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2
  exit 1
fi
# Debug output names TUF, as the real gh does; it must never decide a verdict.
case "${GH_DEBUG:-0}" in
  0 | '') ;;
  *) echo '* Request to https://tuf-repo-cdn.sigstore.dev/15.root.json' >&2 ;;
esac
if [ "$MODE" = needs-token ]; then
  echo "To get started with GitHub CLI, please run:  gh auth login" >&2
  exit 1
fi
# A token in the environment makes this stub accept anything, as a token-backed
# gh would. A leaked token therefore shows as an accepted forgery.
if [ -n "${GITHUB_TOKEN:-}" ] || { [ -n "${GH_TOKEN:-}" ] && [ "$GH_TOKEN" != placeholder-not-a-credential ]; }; then
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
expect_fail auth-visible "ASSERT FAILED: probe environment is not token-less"

# The green case: the real digest verifies, the forged one is refused for identity,
# and the stub never saw a token.
printf '%s\n' identity > "$WORK/bin/mode"
: > "$WORK/bin/calls.log"
if ! "$PROBE" "$REAL" "$FORGED" > "$OUT" 2>&1; then
  echo "FAIL [identity]: the probe failed, expected a pass:"
  sed 's/^/    /' "$OUT"
  FAILED=1
elif ! grep -Fq 'TOKENLESS VERIFY OK' "$OUT" || ! grep -Fq 'refused for its identity' "$OUT"; then
  echo "FAIL [identity]: the pass did not print both results:"
  sed 's/^/    /' "$OUT"
  FAILED=1
elif grep -Fq 'token-visible' "$WORK/bin/calls.log"; then
  echo "FAIL [identity]: a token reached gh under the probe"
  FAILED=1
else
  echo "ok   [identity]: the real digest verified and the forged digest was refused for its identity, with no token"
fi

# Placeholder mode: the one literal placeholder is accepted and drives the same
# verdicts; any other value is refused before gh runs.
printf '%s\n' identity > "$WORK/bin/mode"
if ! PROBE_GH_TOKEN_PLACEHOLDER=placeholder-not-a-credential "$PROBE" "$REAL" "$FORGED" > "$OUT" 2>&1; then
  echo "FAIL [placeholder identity]: the probe failed, expected a pass:"
  sed 's/^/    /' "$OUT"
  FAILED=1
elif ! grep -Fq 'GH_TOKEN: the literal placeholder' "$OUT" \
  || ! grep -Fq 'requests logged to api.github.com: 0' "$OUT" \
  || ! grep -Fq 'tuf-repo-cdn.sigstore.dev' "$OUT"; then
  echo "FAIL [placeholder identity]: the pass did not report the placeholder and the API lines:"
  sed 's/^/    /' "$OUT"
  FAILED=1
else
  echo "ok   [placeholder identity]: the same verdicts with the placeholder, API lines reported"
fi

printf '%s\n' needs-token > "$WORK/bin/mode"
if PROBE_GH_TOKEN_PLACEHOLDER=placeholder-not-a-credential "$PROBE" "$REAL" "$FORGED" > "$OUT" 2>&1 \
  || ! grep -Fq 'ASSERT FAILED: verification needs a GitHub token' "$OUT"; then
  echo "FAIL [placeholder needs-token]: expected the token-need assertion:"
  sed 's/^/    /' "$OUT"
  FAILED=1
else
  echo "ok   [placeholder needs-token]: a token need still names its mechanism"
fi

printf '%s\n' identity > "$WORK/bin/mode"
: > "$WORK/bin/calls.log"
if PROBE_GH_TOKEN_PLACEHOLDER=some-other-value "$PROBE" "$REAL" "$FORGED" > "$OUT" 2>&1 \
  || ! grep -Fq 'ASSERT FAILED: PROBE_GH_TOKEN_PLACEHOLDER must be the literal' "$OUT" \
  || [ -s "$WORK/bin/calls.log" ]; then
  echo "FAIL [placeholder other value]: expected a refusal before gh ran:"
  sed 's/^/    /' "$OUT"
  FAILED=1
else
  echo "ok   [placeholder other value]: any other value is refused before gh runs"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "probe test FAILED"
  exit 1
fi
echo "probe test passed"
