#!/bin/sh
# The checkout half of the content-policy gate: a real headless Chromium takes a
# member through the paid upgrade and the return from checkout on a real Ghost
# behind the edge policy, with a fake Stripe API standing in for the service we
# cannot reach from a laptop without an account. Usage, modes and what it does
# NOT prove: csp-checkout-gate.md.
set -e
# Never trace: real test mode holds Stripe keys in this shell's environment.
set +x

SABOTAGE=""
DERIVE=""
HELP=""
IMAGE=""
for arg in "$@"; do
    case "$arg" in
        --sabotage=no-stripe-origin) SABOTAGE="${arg#--sabotage=}" ;;
        --sabotage=*) echo "unknown sabotage: $arg" >&2; exit 2 ;;
        --derive) DERIVE=1 ;;
        --help|-h) HELP=1 ;;
        *) IMAGE="$arg" ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
. "$REPO_ROOT/csp/gate/lib.sh"

# The opt-in real Stripe TEST-mode switch (csp/gate/csp-checkout-gate.md). Every
# refusal lives in csp/proof/real-test-mode.mjs; with the switch unset nothing
# below it is read and the fake Stripe runs exactly as before.
REAL=""
case "${CSP_STRIPE_REAL_TEST_MODE:-}" in
    "") ;;
    1) REAL=1 ;;
    *) echo "CSP_STRIPE_REAL_TEST_MODE must be 1 (or unset for the fake Stripe)" >&2; exit 2 ;;
esac
if [ -n "$HELP" ]; then
    node csp/proof/real-test-mode.mjs help
    exit 0
fi
if [ -n "$REAL" ] && [ -n "$DERIVE" ]; then
    echo "--derive needs no keys and measures the real Stripe.js: run it without CSP_STRIPE_REAL_TEST_MODE" >&2
    exit 2
fi
if [ -n "$REAL" ]; then
    # Before anything starts: the keys' shapes, a local tenant, the test card.
    node csp/proof/real-test-mode.mjs preflight --origin "http://localhost:${CSP_CHECKOUT_PORT:-4321}" || exit 2
    PROOF_REAL_TEST_MODE=1
    export PROOF_REAL_TEST_MODE
fi

if [ -n "$DERIVE" ] && [ "${CSP_STRIPE_REAL_JS:-}" != "1" ]; then
    echo "--derive measures the origins the REAL Stripe.js needs: run it with CSP_STRIPE_REAL_JS=1" >&2
    exit 2
fi
if [ ! -f render-core/dist/index.js ]; then
    echo "render-core is not built: the policy is rendered through its built output (cd render-core && pnpm run build)" >&2
    exit 2
fi

NET="csp-checkout-net-$$"
GHOST_NAME="csp-checkout-ghost-$$"
ORIGIN_NAME="csp-checkout-origin-$$"
FAKE_NAME="csp-checkout-stripe-$$"
HOST_PORT="${CSP_CHECKOUT_PORT:-4321}"
STRIPE_PORT="${CSP_CHECKOUT_STRIPE_PORT:-4322}"
ORIGIN="http://localhost:${HOST_PORT}"

cleanup() {
    # -v also removes each container's anonymous volumes: Ghost's image declares
    # a content volume, and in real mode it holds the owner's test keys.
    docker rm -fv "$GHOST_NAME" "$ORIGIN_NAME" "$FAKE_NAME" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# TEST MODE ONLY, synthetic and per run. Ghost validates only the shape
# (sk_test_ or pk_test_ plus alphanumerics); the Stripe it reaches is
# csp/proof/fake-stripe.mjs, which refuses any key that is not sk_test_. No
# real key, no account, nothing to commit.
rand() { LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 24; }
STRIPE_SECRET_KEY="sk_test_$(rand)"
STRIPE_PUBLISHABLE_KEY="pk_test_$(rand)"
WEBHOOK_SECRET="whsec_$(rand)"
if [ -n "$REAL" ]; then
    # The owner's own test-mode values replace the synthetic ones, in this
    # shell's variables only: never an argument, never echoed.
    STRIPE_SECRET_KEY="$STRIPE_TEST_SECRET_KEY"
    STRIPE_PUBLISHABLE_KEY="$STRIPE_TEST_PUBLISHABLE_KEY"
    WEBHOOK_SECRET="$STRIPE_TEST_WEBHOOK_SECRET"
fi

if [ -z "$IMAGE" ]; then
    IMAGE="csp-gate-ghost:local"
    docker build -q -t "$IMAGE" . >/dev/null
fi
docker build -q -f csp/proof/Dockerfile -t csp-gate-origin:local . >/dev/null
docker network create "$NET" >/dev/null

if [ -n "$REAL" ]; then
    # No fake: Ghost's Stripe client keeps its default host, Stripe's own API.
    # WEBHOOK_SECRET is passed by name, so the value is read from this shell's
    # environment and is not in any argument list. Stripe reaches the tenant's
    # webhook route through the owner's `stripe listen` (printed by preflight).
    export WEBHOOK_SECRET
    ghost_start "$GHOST_NAME" "$NET" "$ORIGIN" "$IMAGE" \
        -e stripeDirect=true \
        -e WEBHOOK_SECRET
else
# The fake runs on the Ghost image's own node, so nothing new is pulled and it
# is reachable by container name on the private network. Its port is published
# on loopback only.
docker run -d --name "$FAKE_NAME" --network "$NET" -p "127.0.0.1:${STRIPE_PORT}:12111" \
    -v "$REPO_ROOT/csp/proof:/proof:ro" \
    -e "FAKE_STRIPE_PUBLIC_URL=http://localhost:${STRIPE_PORT}" \
    -e "FAKE_STRIPE_WEBHOOK_URL=http://${GHOST_NAME}:2368/members/webhooks/stripe/" \
    -e "FAKE_STRIPE_WEBHOOK_SECRET=$WEBHOOK_SECRET" \
    --entrypoint node "$IMAGE" /proof/fake-stripe.mjs >/dev/null

# stripeDirect makes Ghost use the keys set through its settings; the
# STRIPE_API_* variables point its Stripe client at the fake; WEBHOOK_SECRET
# puts the webhook manager in its "local" mode (the stripe-cli mode), so Ghost
# verifies the fake's signatures with a secret we hold instead of registering
# an endpoint with Stripe.
ghost_start "$GHOST_NAME" "$NET" "$ORIGIN" "$IMAGE" \
    -e stripeDirect=true \
    -e "STRIPE_API_HOST=$FAKE_NAME" \
    -e STRIPE_API_PORT=12111 \
    -e STRIPE_API_PROTOCOL=http \
    -e "WEBHOOK_SECRET=$WEBHOOK_SECRET"
fi
wait_for "Ghost" 90 docker exec "$GHOST_NAME" wget -q -O /dev/null http://127.0.0.1:2368/

start_origin() { # header name, header value
    docker rm -fv "$ORIGIN_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$ORIGIN_NAME" --network "$NET" -p "${HOST_PORT}:8080" \
        -e "GHOST_UPSTREAM=${GHOST_NAME}:2368" \
        -e "CSP_HEADER_NAME=$1" -e "CSP_HEADER_VALUE=$2" \
        csp-gate-origin:local >/dev/null
    wait_for "origin" 30 curl -sf -o /dev/null "$ORIGIN/"
}

start_origin "X-Csp-Gate-Marker" "none"
if [ -z "$REAL" ]; then
    wait_for "fake Stripe" 30 curl -sf -o /dev/null "http://localhost:${STRIPE_PORT}/__state"
fi
eval "$(PROOF_ORIGIN="$ORIGIN" node csp/proof/setup-content.mjs)"
PROOF_ORIGIN="$ORIGIN" PROOF_SESSION_COOKIE="$SESSION_COOKIE" \
    PROOF_STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" PROOF_STRIPE_PUBLISHABLE_KEY="$STRIPE_PUBLISHABLE_KEY" \
    node csp/proof/setup-paid.mjs >/dev/null

# The theme's own script hashes, from the CLEAN pages of the paid-enabled site
# (the Stripe tag has a src, so it is not hashed: the hashes are unchanged).
PATHS="/,/${POST_SLUG}/,/tag/${TAG_SLUG}/,/author/${AUTHOR_SLUG}/"
HASHES_JSON="$(GHOST_ORIGIN="$ORIGIN" CSP_DERIVE_PATHS="$PATHS" node csp/derive/derive-script-hashes.mjs)"

render_policy() { # payments kind: stripe | none
    printf '%s' "$HASHES_JSON" | CSP_PAYMENTS="$1" node csp/proof/render-header.mjs
}

capture() { # label
    PROOF_ORIGIN="$ORIGIN" PROOF_LABEL="$1" PROOF_SESSION_COOKIE="$SESSION_COOKIE" \
        PROOF_STRIPE_URL="http://localhost:${STRIPE_PORT}" \
        node csp/proof/capture-checkout.mjs
}

if [ -n "$DERIVE" ]; then
    # Measuring, not judging: the strict policy with NO payments allowance,
    # served REPORT-ONLY so nothing hides behind the first block, against the
    # real Stripe.js. The result is compared with the committed allowlist.
    NONE_VALUE="$(render_policy none | cut -f2)"
    start_origin "Content-Security-Policy-Report-Only" "$NONE_VALUE"
    RUN_JSON="$(capture derive)"
    echo "$RUN_JSON"
    printf '%s' "$RUN_JSON" | node csp/derive/derive-payment-origins.mjs --check
    exit $?
fi

# Gating: the ENFORCING policy under test. The sabotage serves the same Ghost
# with the payments allowance removed -- the policy as it was before this gate
# existed -- and must go red, naming the Stripe origin.
case "$SABOTAGE" in
    no-stripe-origin) RENDERED="$(render_policy none)" ;;
    *) RENDERED="$(render_policy stripe)" ;;
esac
if [ "$(printf '%s' "$RENDERED" | cut -f1)" != "enforcing" ]; then
    echo "FAILED: the policy under test is not enforcing (no theme hashes derived?)" >&2
    exit 2
fi
POLICY_VALUE="$(printf '%s' "$RENDERED" | cut -f2)"
echo "POLICY ${SABOTAGE:-payments=stripe}: $POLICY_VALUE"

GATE_START="$(date +%s)"
start_origin "Content-Security-Policy" "$POLICY_VALUE"
RUN_JSON="$(capture "checkout${SABOTAGE:+-$SABOTAGE}")"
echo "$RUN_JSON"
set +e
printf '%s' "$RUN_JSON" | node csp/gate/checkout-gate.mjs
STATUS=$?
set -e
echo "GATE_TIMING seconds=$(($(date +%s) - GATE_START)) sabotage=${SABOTAGE:-none} exit=$STATUS"
exit "$STATUS"
