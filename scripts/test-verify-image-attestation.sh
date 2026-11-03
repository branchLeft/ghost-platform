#!/bin/sh
# Proves scripts/verify-image-attestation.sh refuses what it exists to refuse.
# A stub `gh` stands in for the real one, so this needs no network and no
# attestation. The stub emulates the part of `gh attestation verify` that
# matters: it needs --repo, accepts an attestation only when --signer-workflow
# (if given) equals the identity the image was signed with, and only when
# --source-ref (if given) is refs/heads/main. Like the real gh, it accepts
# anything in the repository when a flag is left off, so a script that quietly
# drops --signer-workflow is accepted by the stub and the wrong-signer case
# goes red.
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
if [ -n "$signer" ] && [ "$signer" != "$STUB_SIGNED_BY" ]; then exit 1; fi
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

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "all checks passed"
