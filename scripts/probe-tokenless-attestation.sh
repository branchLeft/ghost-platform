#!/bin/sh
# Proves that the host verifier can judge an attestation with no GitHub token in
# the environment. The verifier runs under a scrubbed environment, the way a host
# runs it: no token variable and no gh credentials. It must verify the real
# digest, and it must refuse a digest that another workflow built, for its
# identity. A token need, or a network or Sigstore fault, is never read as a
# verdict. Refusal and fault wording: scripts/probe-tokenless-attestation.md.
#
# Usage:
#   ./scripts/probe-tokenless-attestation.sh <real image@sha256:64hex> <forged image@sha256:64hex>
#
# The scrubbed environment copies the keys the host sets for the verifier:
# PATH, HOME, GH_CONFIG_DIR and XDG_CONFIG_HOME (all an empty directory),
# GH_PROMPT_DISABLED, GH_NO_UPDATE_NOTIFIER, LC_ALL and VERIFY_PLAIN_ERRORS. The
# host's function lives in another repository, so these values are copied here
# by hand. Keep them in step with that function.
#
# PROBE_RETRY_WAIT sets the wait between transport retries (20 seconds by
# default). The offline test sets it to 0.
#
# Placeholder mode. PROBE_GH_TOKEN_PLACEHOLDER=placeholder-not-a-credential runs
# the same probe with GH_TOKEN set to that one literal string, plus one extra
# debug call (GH_DEBUG=api) that lists the hosts gh logs, to show whether gh's
# local auth gate takes any value on the
# --bundle-from-oci path and whether any call to the GitHub API is made. Any
# other value is refused, so a real token can never be passed this way.
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
PLACEHOLDER="${PROBE_GH_TOKEN_PLACEHOLDER:-}"
DEBUG_VAL=0
if [ -n "$PLACEHOLDER" ] && [ "$PLACEHOLDER" != "placeholder-not-a-credential" ]; then
  assert_fail "PROBE_GH_TOKEN_PLACEHOLDER must be the literal placeholder-not-a-credential, nothing else"
fi

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
  if [ -n "$PLACEHOLDER" ]; then
    env -i PATH="$GH_DIR:/usr/bin:/bin" HOME="$EMPTY" GH_CONFIG_DIR="$EMPTY" \
      XDG_CONFIG_HOME="$EMPTY" GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 \
      LC_ALL=C VERIFY_PLAIN_ERRORS=1 GH_TOKEN="$PLACEHOLDER" GH_DEBUG="$DEBUG_VAL" "$@"
  else
    env -i PATH="$GH_DIR:/usr/bin:/bin" HOME="$EMPTY" GH_CONFIG_DIR="$EMPTY" \
      XDG_CONFIG_HOME="$EMPTY" GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 \
      LC_ALL=C VERIFY_PLAIN_ERRORS=1 "$@"
  fi
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
for name in GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; do
  if [ -n "$PLACEHOLDER" ] && [ "$name" = GH_TOKEN ]; then
    # shellcheck disable=SC2016
    if [ "$(scrubbed sh -c 'printf %s "$GH_TOKEN"')" != "$PLACEHOLDER" ]; then
      assert_fail "placeholder mode: GH_TOKEN is not the placeholder"
    fi
    echo "  GH_TOKEN: the literal placeholder, not a credential"
    continue
  fi
  if scrubbed sh -c "test -n \"\${$name+set}\""; then
    assert_fail "probe environment is not token-less: $name is set"
  fi
  echo "  $name: unset"
done
if [ -e "$EMPTY/hosts.yml" ]; then
  assert_fail "probe environment is not token-less: a gh hosts file exists"
fi
echo "  gh config directory: no hosts file"
if [ -z "$PLACEHOLDER" ]; then
  if scrubbed gh auth status >"$WORK/auth.out" 2>&1; then
    assert_fail "probe environment is not token-less: gh auth status succeeded"
  fi
  echo "  gh auth status: exits non-zero"
fi

# In placeholder mode, one extra verifier call on the real digest with GH_DEBUG=api,
# kept apart from the output the verdicts are read from (the debug text names TUF
# and other words the classes match on). It lists the hosts gh logged a request to.
api_evidence() {
  [ -n "$PLACEHOLDER" ] || return 0
  echo "Evidence: which hosts gh logs a request to, on the real digest (GH_DEBUG=api)"
  DEBUG_VAL=api
  scrubbed "$VERIFY" "$REAL" "$REPO" "$SIGNER" --bundle-from-oci >"$WORK/debug.out" 2>&1
  debug_rc=$?
  DEBUG_VAL=0
  echo "  debug call exit: $debug_rc"
  echo "  requests logged to api.github.com: $(grep -c '^\* Request to https://api\.github\.com' "$WORK/debug.out")"
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

echo "Real digest: verify $REAL with --bundle-from-oci, token-less"
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
echo "TOKENLESS VERIFY OK"

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
echo "PROBE PASSED: the real digest verified with no token, and the forged digest was refused for its identity"
