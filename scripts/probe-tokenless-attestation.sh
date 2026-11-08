#!/bin/sh
# Proves that the host's attestation verifier works as the host runs it: with
# GH_TOKEN set to one fixed placeholder string and nothing else. gh needs a
# non-empty GH_TOKEN to start, but on the --bundle-from-oci path it makes no
# GitHub API call, so the verdict is cryptographic and the placeholder carries no
# authority. The probe must verify the real digest, and it must refuse a digest
# that another workflow built, for its identity. A token need, or a network or
# Sigstore fault, is never read as a verdict. Wording and findings:
# scripts/probe-tokenless-attestation.md.
#
# Usage:
#   ./scripts/probe-tokenless-attestation.sh <real image@sha256:64hex> <forged image@sha256:64hex>
#
# The scrubbed environment copies the keys the host sets for the verifier:
# PATH, HOME, GH_CONFIG_DIR and XDG_CONFIG_HOME (all an empty directory),
# GH_PROMPT_DISABLED, GH_NO_UPDATE_NOTIFIER, LC_ALL, VERIFY_PLAIN_ERRORS and
# GH_TOKEN (the placeholder). The host's function lives in another repository
# (the host verifier), so these values are copied here by hand. Keep them in
# step with that function.
#
# One extra call on the real digest runs with GH_DEBUG=api, kept apart from the
# output the verdicts are read from, and lists the hosts gh logs a request to.
#
# PROBE_RETRY_WAIT sets the wait between transport retries (20 seconds by
# default). The offline test sets it to 0.
set -u

assert_fail() {
  echo "ASSERT FAILED: $1"
  exit 1
}

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <real image@sha256:64hex> <forged image@sha256:64hex>" >&2
  exit 2
fi
REAL="$1"
FORGED="$2"

HERE="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$HERE/verify-image-attestation.sh"
REPO="branchLeft/ghost-platform"
SIGNER="branchLeft/ghost-platform/.github/workflows/registry-push.yml"
RETRY_WAIT="${PROBE_RETRY_WAIT:-20}"
PLACEHOLDER="placeholder-not-a-credential"
DEBUG_VAL=0

TOKEN_RE='gh auth login|GH_TOKEN|GITHUB_TOKEN|HTTP 40[13]|authentication|not logged in|unauthorized|forbidden'
TRANSPORT_RE='dial tcp|i/o timeout|no such host|connection reset|connection refused|TUF'
IDENTITY_RE='no matching CertificateIdentity|Subject Alternative Name|Policy verification failed'

if ! command -v gh >/dev/null 2>&1; then
  assert_fail "gh is not on PATH"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
EMPTY="$WORK/gh-config"
mkdir "$EMPTY"
GH_DIR="$(dirname "$(command -v gh)")"

# Runs a command under the host's scrubbed environment.
scrubbed() {
  env -i PATH="$GH_DIR:/usr/bin:/bin" HOME="$EMPTY" GH_CONFIG_DIR="$EMPTY" \
    XDG_CONFIG_HOME="$EMPTY" GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 \
    LC_ALL=C VERIFY_PLAIN_ERRORS=1 GH_TOKEN="$PLACEHOLDER" GH_DEBUG="$DEBUG_VAL" "$@"
}

has_match() {
  grep -Eiq "$1" "$WORK/verify.out"
}

# The gh line that decides the branch: a marker, an error, or the identity wording.
mechanism() {
  m="$(grep -Ei "$TOKEN_RE|$TRANSPORT_RE|error|failed|no matching|subject alternative|verifying with issuer|no valid attestation" "$WORK/verify.out" | head -n 1)"
  if [ -z "$m" ]; then
    m="$(tail -n 1 "$WORK/verify.out")"
  fi
  printf '%s' "$m"
}

echo "Environment proof: the verifier runs under a scrubbed environment"
# shellcheck disable=SC2016
if [ "$(scrubbed sh -c 'printf %s "$GH_TOKEN"')" != "$PLACEHOLDER" ]; then
  assert_fail "probe environment: GH_TOKEN is not the placeholder"
fi
echo "  GH_TOKEN: the literal placeholder, not a credential"
for name in GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; do
  if scrubbed sh -c "test -n \"\${$name+set}\""; then
    assert_fail "probe environment holds a token: $name is set"
  fi
  echo "  $name: unset"
done
if [ -e "$EMPTY/hosts.yml" ]; then
  assert_fail "probe environment holds a credential: a gh hosts file exists"
fi
echo "  gh config directory: no hosts file"

# One extra verifier call on the real digest with GH_DEBUG=api. Sets API_CALLS to
# the number of requests logged to api.github.com.
api_evidence() {
  echo "Evidence: which hosts gh logs a request to, on the real digest (GH_DEBUG=api)"
  DEBUG_VAL=api
  scrubbed "$VERIFY" "$REAL" "$REPO" "$SIGNER" --bundle-from-oci >"$WORK/debug.out" 2>&1
  debug_rc=$?
  DEBUG_VAL=0
  API_CALLS="$(grep -c '^\* Request to https://api\.github\.com' "$WORK/debug.out")"
  echo "  debug call exit: $debug_rc"
  echo "  requests logged to api.github.com: $API_CALLS"
  echo "  requests logged in all: $(grep -c '^\* Request to ' "$WORK/debug.out")"
  echo "  hosts requested:"
  sed -n 's|^\* Request to https://\([^/]*\)/.*|\1|p' "$WORK/debug.out" | sort | uniq -c | sed 's/^/    /'
  echo "  Authorization headers logged: $(grep -c '^> Authorization:' "$WORK/debug.out")"
}
api_evidence

# One verifier call under the scrubbed environment. A transport fault is retried
# up to four attempts; anything else is final. Sets RC, and leaves the output in
# $WORK/verify.out.
run_verify() {
  attempt=1
  while :; do
    scrubbed "$VERIFY" "$1" "$REPO" "$SIGNER" --bundle-from-oci >"$WORK/verify.out" 2>&1
    RC=$?
    if [ "$RC" -eq 0 ] || has_match "$TOKEN_RE" || ! has_match "$TRANSPORT_RE"; then
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      return 0
    fi
    echo "  transport fault on attempt $attempt of 4, retrying in ${RETRY_WAIT}s"
    sleep "$RETRY_WAIT"
    attempt=$((attempt + 1))
  done
}

echo "Real digest: verify $REAL with --bundle-from-oci and the placeholder GH_TOKEN"
run_verify "$REAL"
if [ "$RC" -ne 0 ]; then
  if has_match "$TOKEN_RE"; then
    assert_fail "verification needs a GitHub token (mechanism: $(mechanism))"
  fi
  if has_match "$TRANSPORT_RE"; then
    assert_fail "verification of the real digest hit a fault, not a verdict (mechanism: $(mechanism))"
  fi
  assert_fail "refused for the attestation or identity (mechanism: $(mechanism))"
fi
sed 's/^/  /' "$WORK/verify.out"
if [ "$API_CALLS" -eq 0 ]; then
  echo "VERIFIED with a placeholder GH_TOKEN; no GitHub API call observed"
else
  echo "VERIFIED with a placeholder GH_TOKEN; $API_CALLS GitHub API calls observed"
fi

echo "Control: verify the forged digest $FORGED with the same call"
run_verify "$FORGED"
if [ "$RC" -eq 0 ]; then
  assert_fail "forged digest accepted: the probe is vacuous"
fi
if has_match "$TOKEN_RE"; then
  assert_fail "forged digest refused by a token need, not by identity (mechanism: $(mechanism))"
fi
if has_match "$TRANSPORT_RE"; then
  assert_fail "forged digest refused by a fault, not by identity (mechanism: $(mechanism))"
fi
if ! has_match "$IDENTITY_RE" && ! { has_match 'verifying with issuer' && has_match 'no valid attestation for'; }; then
  assert_fail "forged digest refused, but gh did not name the identity (mechanism: $(mechanism))"
fi
sed 's/^/  /' "$WORK/verify.out"
echo "forged digest refused for its identity (mechanism: $(mechanism))"
echo "PROBE PASSED: the real digest verified with a placeholder GH_TOKEN, and the forged digest was refused for its identity"
