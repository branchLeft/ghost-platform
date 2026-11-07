#!/bin/sh
# The checkout half of the content-policy gate: a real headless Chromium walks
# a visitor through sign-up, the magic-link round trip, the paid upgrade and the
# return from checkout on a real Ghost behind the edge policy, with a fake
# Stripe API and a local SMTP sink standing in for the two services we cannot
# reach from a laptop. Usage, modes and what it does NOT prove:
# csp-checkout-gate.md.
set -e

SABOTAGE=""
DERIVE=""
IMAGE=""
for arg in "$@"; do
    case "$arg" in
        --sabotage=no-stripe-origin) SABOTAGE="${arg#--sabotage=}" ;;
        --sabotage=*) echo "unknown sabotage: $arg" >&2; exit 2 ;;
        --derive) DERIVE=1 ;;
        *) IMAGE="$arg" ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
. "$REPO_ROOT/csp/gate/lib.sh"

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
SINK_NAME="csp-checkout-sink-$$"
FAKE_NAME="csp-checkout-stripe-$$"
HOST_PORT="${CSP_CHECKOUT_PORT:-4321}"
STRIPE_PORT="${CSP_CHECKOUT_STRIPE_PORT:-4322}"
SINK_PORT="${CSP_CHECKOUT_SINK_PORT:-4323}"
ORIGIN="http://localhost:${HOST_PORT}"

cleanup() {
    docker rm -f "$GHOST_NAME" "$ORIGIN_NAME" "$SINK_NAME" "$FAKE_NAME" >/dev/null 2>&1 || true
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

if [ -z "$IMAGE" ]; then
    IMAGE="csp-gate-ghost:local"
    docker build -q -t "$IMAGE" . >/dev/null
fi
docker build -q -f csp/proof/Dockerfile -t csp-gate-origin:local . >/dev/null
docker network create "$NET" >/dev/null

# The two stand-ins run on the Ghost image's own node, so nothing new is
# pulled and both are reachable by container name on the private network.
# Their ports are published on loopback only.
docker run -d --name "$SINK_NAME" --network "$NET" -p "127.0.0.1:${SINK_PORT}:2526" \
    -v "$REPO_ROOT/csp/proof:/proof:ro" --entrypoint node "$IMAGE" /proof/smtp-sink.mjs >/dev/null
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
    -e mail__transport=SMTP \
    -e "mail__options__host=$SINK_NAME" \
    -e mail__options__port=2525 \
    -e mail__options__secure=false \
    -e "mail__from=CSP Proof <csp-proof@example.test>" \
    -e stripeDirect=true \
    -e "STRIPE_API_HOST=$FAKE_NAME" \
    -e STRIPE_API_PORT=12111 \
    -e STRIPE_API_PROTOCOL=http \
    -e "WEBHOOK_SECRET=$WEBHOOK_SECRET"
wait_for "Ghost" 90 docker exec "$GHOST_NAME" wget -q -O /dev/null http://127.0.0.1:2368/

start_origin() { # header name, header value
    docker rm -f "$ORIGIN_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$ORIGIN_NAME" --network "$NET" -p "${HOST_PORT}:8080" \
        -e "GHOST_UPSTREAM=${GHOST_NAME}:2368" \
        -e "CSP_HEADER_NAME=$1" -e "CSP_HEADER_VALUE=$2" \
        csp-gate-origin:local >/dev/null
    wait_for "origin" 30 curl -sf -o /dev/null "$ORIGIN/"
}

start_origin "X-Csp-Gate-Marker" "none"
wait_for "fake Stripe" 30 curl -sf -o /dev/null "http://localhost:${STRIPE_PORT}/__state"
wait_for "SMTP sink" 30 curl -sf -o /dev/null "http://127.0.0.1:${SINK_PORT}/messages"
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
        PROOF_SINK_URL="http://127.0.0.1:${SINK_PORT}" PROOF_STRIPE_URL="http://localhost:${STRIPE_PORT}" \
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
