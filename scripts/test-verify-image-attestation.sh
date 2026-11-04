#!/bin/sh
# Proves the verify and wrong-identity scripts refuse what they should, against
# a stub gh on PATH, so no network or attestation is needed. The stub and its
# cases are described in scripts/test-verify-image-attestation.md.
#
# Usage:
#   ./scripts/test-verify-image-attestation.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/verify-image-attestation.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
mkdir "$WORK/bin"
export GH_LOG="$WORK/gh.log"

cat > "$WORK/bin/gh" <<'STUB'
#!/bin/sh
# Record every argument, one per line, then decide like gh would.
for a in "$@"; do printf '%s\n' "$a" >> "$GH_LOG"; done
printf -- '--call-end--\n' >> "$GH_LOG"
if [ "${STUB_MODE:-}" = "fail" ]; then
  exit 1
fi
# Faults that are not a rejection: a network failure, and a Sigstore TUF fetch.
if [ "${STUB_MODE:-}" = "network" ]; then
  echo 'Get "https://api.github.com/repos/branchLeft/ghost-platform/attestations/sha256:aaaa": dial tcp: lookup api.github.com: no such host' >&2
  exit 1
fi
if [ "${STUB_MODE:-}" = "tuf" ]; then
  echo "Sigstore verification failed: failed to fetch the TUF root: connection reset by peer" >&2
  exit 1
fi
if [ "${STUB_MODE:-}" = "accept" ]; then
  exit 0
fi
repo=""
signer=""
ref=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift ;;
    --signer-workflow) signer="$2"; shift ;;
    --source-ref) ref="$2"; shift ;;
  esac
  shift
done
[ -n "$repo" ] || exit 1
if [ -n "$signer" ] && [ "$signer" != "$STUB_SIGNED_BY" ]; then
  echo "Error: Policy verification failed: no matching CertificateIdentity found, last error: Subject Alternative Name must match regex" >&2
  exit 1
fi
if [ -n "$ref" ] && [ "$ref" != "refs/heads/main" ]; then exit 1; fi
exit 0
STUB
chmod +x "$WORK/bin/gh"
PATH="$WORK/bin:$PATH"
export PATH

REPO="branchLeft/ghost-platform"
SIGNER="$REPO/.github/workflows/registry-push.yml"
DIGEST="sha256:$(printf 'a%.0s' $(seq 1 64))"
GOOD_REF="ghcr.io/branchleft/ghost-tenant@$DIGEST"
STUB_SIGNED_BY="$SIGNER"
export STUB_SIGNED_BY

FAILURES=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILURES=$((FAILURES + 1)); }

# run_case <name> <expected: zero|nonzero> <gh-calls: 0|1> <script args...>
run_case() {
  name="$1"; want="$2"; calls="$3"; shift 3
  : > "$GH_LOG"
  "$SCRIPT" "$@" > "$WORK/out" 2>&1
  code=$?
  made="$(grep -c -- '--call-end--' "$GH_LOG")"
  ok=1
  if [ "$want" = "zero" ] && [ "$code" -ne 0 ]; then ok=0; fi
  if [ "$want" = "nonzero" ] && [ "$code" -eq 0 ]; then ok=0; fi
  if [ "$made" -ne "$calls" ]; then ok=0; fi
  if [ "$ok" -eq 1 ]; then pass "$name"; else fail "$name (exit $code, gh calls $made, wanted $want and $calls)"; sed 's/^/        /' "$WORK/out"; fi
}

has_arg() { grep -qxF -- "$1" "$GH_LOG"; }

# (a) the correct reference and identity verify, and every identity flag is forwarded.
run_case "a. correct digest reference and identity verifies" zero 1 "$GOOD_REF" "$REPO" "$SIGNER"
for want in "oci://$GOOD_REF" "--repo" "$REPO" "--signer-workflow" "$SIGNER" \
  "--source-ref" "refs/heads/main" "--cert-oidc-issuer" \
  "https://token.actions.githubusercontent.com" "--deny-self-hosted-runners"; do
  if has_arg "$want"; then pass "a. gh was given $want"; else fail "a. gh was not given $want"; fi
done
if has_arg "--bundle-from-oci"; then fail "a. --bundle-from-oci must not be sent unless asked for"; else pass "a. no --bundle-from-oci unless asked for"; fi

# (a2) the registry bundle option is forwarded when asked for.
run_case "a2. --bundle-from-oci verifies" zero 1 "$GOOD_REF" "$REPO" "$SIGNER" --bundle-from-oci
if has_arg "--bundle-from-oci"; then pass "a2. gh was given --bundle-from-oci"; else fail "a2. gh was not given --bundle-from-oci"; fi

# (b) a tag-form reference is refused before gh is called.
run_case "b. tag-form reference is refused before gh" nonzero 0 "ghcr.io/branchleft/ghost-tenant:latest" "$REPO" "$SIGNER"
run_case "b2. reference with no tag or digest is refused before gh" nonzero 0 "ghcr.io/branchleft/ghost-tenant" "$REPO" "$SIGNER"
run_case "b3. short digest is refused before gh" nonzero 0 "ghcr.io/branchleft/ghost-tenant@sha256:abc123" "$REPO" "$SIGNER"
run_case "b4. upper-case image name is refused before gh" nonzero 0 "ghcr.io/branchLeft/ghost-tenant@$DIGEST" "$REPO" "$SIGNER"

# (c) a signer workflow the image was not signed by is rejected.
run_case "c. wrong signer workflow is rejected" nonzero 1 "$GOOD_REF" "$REPO" "$REPO/.github/workflows/portal-apps-image.yml"
run_case "c2. signer with a suffix is rejected" nonzero 1 "$GOOD_REF" "$REPO" "$SIGNER.sabotage"
run_case "c3. signer in another repository is refused before gh" nonzero 0 "$GOOD_REF" "$REPO" "other/repo/.github/workflows/registry-push.yml"
run_case "c4. signer that is not a workflow path is refused before gh" nonzero 0 "$GOOD_REF" "$REPO" "$REPO"

# (d) a missing or surplus argument is refused before gh.
run_case "d. no arguments" nonzero 0
run_case "d2. missing signer" nonzero 0 "$GOOD_REF" "$REPO"
run_case "d3. unknown fourth argument" nonzero 0 "$GOOD_REF" "$REPO" "$SIGNER" --anything-else
run_case "d4. five arguments" nonzero 0 "$GOOD_REF" "$REPO" "$SIGNER" --bundle-from-oci extra

# (e) gh failing is a failure: the script is fail closed.
STUB_MODE=fail
export STUB_MODE
run_case "e. gh failing is a non-zero exit" nonzero 1 "$GOOD_REF" "$REPO" "$SIGNER"
unset STUB_MODE

# (f) the wrong-identity check. It passes only when gh refuses the wrong signer
# for its identity, through both paths, and a fault or an acceptance fails it.
PROVE="$HERE/prove-wrong-identity-rejected.sh"
run_prove() {
  name="$1"; want="$2"
  : > "$GH_LOG"
  "$PROVE" "$GOOD_REF" "$REPO" "$SIGNER" > "$WORK/out" 2>&1
  code=$?
  ok=1
  if [ "$want" = "zero" ] && [ "$code" -ne 0 ]; then ok=0; fi
  if [ "$want" = "nonzero" ] && [ "$code" -eq 0 ]; then ok=0; fi
  if [ "$want" = "zero" ] && grep -q '::error::' "$WORK/out"; then ok=0; fi
  if [ "$ok" -eq 1 ]; then pass "$name"; else fail "$name (exit $code, wanted $want)"; sed 's/^/        /' "$WORK/out"; fi
}
run_prove "f. a wrong signer is refused for its identity through both paths, with no annotation" zero
STUB_MODE=network
export STUB_MODE
run_prove "f2. a network failure is not a rejection, and fails the check" nonzero
STUB_MODE=tuf
run_prove "f3. a Sigstore TUF failure is not a rejection, and fails the check" nonzero
STUB_MODE=accept
run_prove "f4. a wrong signer that gh accepts fails the check" nonzero
unset STUB_MODE

# (g) VERIFY_PLAIN_ERRORS=1 prints a refusal as plain text. Without it the refusal is an annotation.
: > "$GH_LOG"
code=0
VERIFY_PLAIN_ERRORS=1 "$SCRIPT" "ghcr.io/branchleft/ghost-tenant:latest" "$REPO" "$SIGNER" > "$WORK/out" 2>&1 || code=$?
if [ "$code" -ne 0 ] && grep -q '^error: refusing' "$WORK/out" && ! grep -q '::error::' "$WORK/out"; then
  pass "g. VERIFY_PLAIN_ERRORS=1 prints a plain refusal with no annotation"
else
  fail "g. VERIFY_PLAIN_ERRORS=1 prints a plain refusal with no annotation"; sed 's/^/        /' "$WORK/out"
fi
"$SCRIPT" "ghcr.io/branchleft/ghost-tenant:latest" "$REPO" "$SIGNER" > "$WORK/out" 2>&1
if grep -q '^::error::refusing' "$WORK/out"; then
  pass "g2. without VERIFY_PLAIN_ERRORS the refusal is a ::error:: annotation"
else
  fail "g2. without VERIFY_PLAIN_ERRORS the refusal is a ::error:: annotation"; sed 's/^/        /' "$WORK/out"
fi

# (h) The live wording, from run 41728033706. gh prints "verifying with issuer"
# and then the verify script prints the line naming the identity. A token,
# Sigstore or network fault prints that last line too, so it alone is not a
# refusal. A fake verify script prints each text exactly, beside a copy of the
# prove script.
FAKE="$WORK/fake"
mkdir "$FAKE"
cp "$PROVE" "$FAKE/prove-wrong-identity-rejected.sh"
cat > "$FAKE/verify-image-attestation.sh" <<'FAKE_VERIFY'
#!/bin/sh
cat "$FAKE_TEXT"
exit 1
FAKE_VERIFY
chmod +x "$FAKE/verify-image-attestation.sh"
FAKE_TEXT="$WORK/text"
export FAKE_TEXT
LIVE_GH='Error: verifying with issuer "sigstore.dev"'
LIVE_LINE="error: no valid attestation for $GOOD_REF from $SIGNER.sabotage on refs/heads/main"
NETWORK='error: Get "https://api.github.com/repos/branchLeft/ghost-platform/attestations/sha256:aaaa": dial tcp: i/o timeout'

# run_text <name> <expected: zero|nonzero>: the text in $FAKE_TEXT is the verify output.
run_text() {
  name="$1"; want="$2"
  "$FAKE/prove-wrong-identity-rejected.sh" "$GOOD_REF" "$REPO" "$SIGNER" > "$WORK/out" 2>&1
  code=$?
  ok=1
  if [ "$want" = "zero" ] && [ "$code" -ne 0 ]; then ok=0; fi
  if [ "$want" = "nonzero" ] && [ "$code" -eq 0 ]; then ok=0; fi
  if [ "$want" = "zero" ] && grep -q '::error::' "$WORK/out"; then ok=0; fi
  if [ "$ok" -eq 1 ]; then pass "$name"; else fail "$name (exit $code, wanted $want)"; sed 's/^/        /' "$WORK/out"; fi
}

printf '%s\n' "$LIVE_GH" "$LIVE_LINE" > "$FAKE_TEXT"
run_text "h. (a) the live wording naming the wrong identity is a refusal" zero
printf '%s\n' "$LIVE_GH" "error: no valid attestation for $GOOD_REF from $REPO/.github/workflows/portal-apps-image.yml.sabotage on refs/heads/main" > "$FAKE_TEXT"
run_text "h2. (b) the same wording naming a different identity is not a refusal" nonzero
printf '%s\n' "$LIVE_GH" "error: no valid attestation for $GOOD_REF from $SIGNER on refs/heads/main" > "$FAKE_TEXT"
run_text "h3. (b2) the same wording naming the real signer is not a refusal" nonzero
printf '%s\n' "$NETWORK" > "$FAKE_TEXT"
run_text "h4. (c) a network error is not a refusal" nonzero
printf '%s\n' "$NETWORK" "$LIVE_LINE" > "$FAKE_TEXT"
run_text "h5. (c2) a network error followed by the verify line is not a refusal" nonzero
printf '%s\n' 'error creating Sigstore verifier: no valid Sigstore verifiers could be initialized' "$LIVE_LINE" > "$FAKE_TEXT"
run_text "h6. (c3) a Sigstore verifier that cannot start is not a refusal" nonzero
printf '%s\n' 'Error: the provided token was denied access to the requested resource' "$LIVE_LINE" > "$FAKE_TEXT"
run_text "h7. (c4) a denied token followed by the verify line is not a refusal" nonzero
printf '%s\n' 'Error: Policy verification failed: no matching CertificateIdentity found' > "$FAKE_TEXT"
run_text "h8. (d) the old markers alone are still a refusal" zero
printf '%s\n' "$LIVE_GH" "$NETWORK" "$LIVE_LINE" > "$FAKE_TEXT"
run_text "h9. (e) the live issuer line, a network fault and the verify line is not a refusal" nonzero
printf '%s\n' "$LIVE_GH" 'error: Sigstore verification failed: failed to fetch the TUF root: connection reset by peer' "$LIVE_LINE" > "$FAKE_TEXT"
run_text "h10. (e2) the live issuer line, a Sigstore fault and the verify line is not a refusal" nonzero
printf '%s\n' "$LIVE_GH" 'Error: the provided token was denied access to the requested resource' "$LIVE_LINE" > "$FAKE_TEXT"
run_text "h11. (e3) the live issuer line, a token fault and the verify line is not a refusal" nonzero

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "all checks passed"
