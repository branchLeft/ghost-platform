#!/bin/sh
# Sabotage proof for the gates' verdict logic (the theme-hash, regression and
# checkout gates, and the payment-origin derivation that feeds the policy): for
# each, mutate the real source in place, require its tests to go RED, restore
# it, require them GREEN. A mutation whose target string is not found aborts
# (a sabotage that changed nothing proves nothing). Needs render-core built.
# The live-browser sabotages (policy removed, hashes removed, Stripe origin
# removed) are in csp-regression-gate.sh --sabotage=... and
# csp-checkout-gate.sh --sabotage=...; see their .md files.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
FAIL=0

mutate() { # file, from, to
    node -e '
const fs = require("fs");
const [file, from, to] = process.argv.slice(1);
const s = fs.readFileSync(file, "utf8");
if (!s.includes(from)) { console.error("sabotage target not found: " + from); process.exit(3); }
fs.writeFileSync(file, s.replace(from, to));
' "$@"
}

# The tests that must notice a mutation: this directory's, unless TESTS names one file.
run_tests() {
    if [ -n "${TESTS:-}" ]; then node --test "$TESTS"; else node --test "$HERE"/*.test.mjs; fi
}

prove() { # label, file, from, to
    label="$1"; file="$2"; from="$3"; to="$4"
    cp "$file" "$file.orig"
    trap 'mv -f "$file.orig" "$file"' EXIT INT TERM
    mutate "$file" "$from" "$to" || { mv -f "$file.orig" "$file"; exit 3; }
    if run_tests >/dev/null 2>&1; then
        echo "SABOTAGE $label: NOT DETECTED (tests stayed green)"; FAIL=1
    else
        echo "SABOTAGE $label: RED"
    fi
    mv -f "$file.orig" "$file"
    trap - EXIT INT TERM
    if run_tests >/dev/null 2>&1; then
        echo "RESTORED $label: GREEN"
    else
        echo "RESTORED $label: STILL RED"; FAIL=1
    fi
}

node --test "$HERE"/*.test.mjs >/dev/null 2>&1 && echo "BASELINE: GREEN" || { echo "BASELINE: RED"; exit 1; }

prove "theme-hash/report-only-not-checked" theme-hash-gate.mjs \
    "if (edge.contentSecurityPolicyMode !== 'report-only') {" "if (false) {"
prove "theme-hash/empty-set-enforced" theme-hash-gate.mjs \
    " && derived.hashes.length > 0" ""
prove "theme-hash/recorded-hash-unchecked" theme-hash-gate.mjs \
    "if (!edge.contentSecurityPolicy.includes(\`'\${hash}'\`)) {" "if (false) {"
prove "regression/injected-script-ignored" csp-regression-gate.mjs \
    "if (run.injectedScriptRan !== false) {" "if (false) {"
prove "regression/extra-violations-ignored" csp-regression-gate.mjs \
    "if (violations.length !== 1 || !isAttack(violations[0])) {" "if (violations.length < 1) {"
prove "regression/portal-ignored" csp-regression-gate.mjs \
    "if (run.portalSignInForm !== 'rendered' || !(run.emailFields >= 1)) {" "if (false) {"

prove "regression/attack-directive-unchecked" csp-regression-gate.mjs  "v.directive === 'script-src-elem' && " ""
prove "regression/attack-blocked-uri-unchecked" csp-regression-gate.mjs  " && v.blockedURI === 'inline'" ""
prove "regression/email-field-count-loosened" csp-regression-gate.mjs  "run.emailFields >= 1" "run.emailFields >= 0"
prove "regression/uploaded-script-ignored" csp-regression-gate.mjs \
    "if (run.uploadedScriptRan !== false) {" "if (false) {"
prove "regression/uploaded-script-edge-refusal-unchecked" csp-regression-gate.mjs \
    "} else if (run.uploadedScriptStatus !== 403) {" "} else if (false) {"
prove "regression/uploaded-script-ran-vs-unexercised-confused" csp-regression-gate.mjs \
    "run.uploadedScriptRan === true" "run.uploadedScriptRan === null"
prove "theme-hash/report-only-flag-unchecked" theme-hash-gate.mjs  "if (record.flag !== REPORT_ONLY_FLAG)" "if (false)"
prove "theme-hash/enforcing-mode-unchecked" theme-hash-gate.mjs  "if (edge.contentSecurityPolicyMode !== 'enforcing') {" "if (false) {"

# The checkout gate (Stripe checkout under the strict policy).
prove "checkout/flow-error-ignored" checkout-gate.mjs \
    "if (run.failedAt || run.error) {" "if (false) {"
prove "checkout/member-session-unchecked" checkout-gate.mjs \
    "if (run.memberSession !== true) {" "if (false) {"
prove "checkout/checkout-not-opened-ignored" checkout-gate.mjs \
    "if (run.checkoutOpened !== true) {" "if (false) {"
prove "checkout/return-from-checkout-unchecked" checkout-gate.mjs \
    "if (run.returnedFromCheckout !== true) {" "if (false) {"
prove "checkout/paid-unchecked" checkout-gate.mjs \
    "if (run.paid !== true) {" "if (false) {"
prove "checkout/paid-unchecked-treated-as-paid" checkout-gate.mjs \
    "if (run.paid !== true) {" "if (run.paid === false) {"
prove "checkout/stripe-js-unloaded-ignored" checkout-gate.mjs \
    "if (run.stripeJsLoaded !== true) {" "if (false) {"
prove "checkout/violations-ignored" checkout-gate.mjs \
    "if (violations.length > 0) {" "if (false) {"

# The payment-origin derivation: the tool that decides what widens script-src.
TESTS="$HERE/../derive/derive-payment-origins.test.mjs"
DERIVE="../derive/derive-payment-origins.mjs"
node --test "$TESTS" >/dev/null 2>&1 && echo "BASELINE derive: GREEN" || { echo "BASELINE derive: RED"; exit 1; }
prove "derive/stub-stripe-js-accepted" "$DERIVE" \
    "if (capture.realStripeJs !== true) {" "if (false) {"
prove "derive/enforced-capture-accepted" "$DERIVE" \
    "if (v.disposition !== 'report') {" "if (false) {"
prove "derive/non-stripe-origin-accepted" "$DERIVE" \
    "if (url.protocol !== 'https:' || !isStripeHost(url.hostname)) {" "if (false) {"
prove "derive/empty-capture-accepted" "$DERIVE" \
    "DIRECTIVES.every((d) => origins[d].length === 0)" "false"
prove "derive/unmapped-directive-ignored" "$DERIVE" \
    "if (!directive) {" "if (false) {"
prove "derive/check-never-compares" "$DERIVE" \
    "if (committed !== text) {" "if (false) {"

# The checkout gate's real Stripe test-mode rules (the owner's opt-in run).
TESTS="$HERE/checkout-gate.test.mjs"
prove "checkout-real/fake-capture-accepted-as-real" checkout-gate.mjs \
    "if (realMode && !capturedReal) {" "if (false) {"
prove "checkout-real/real-capture-accepted-as-fake" checkout-gate.mjs \
    "} else if (!realMode && capturedReal) {" "} else if (false) {"
prove "checkout-real/stub-stripe-js-accepted" checkout-gate.mjs \
    "if (run.realStripeJs !== true) {" "if (false) {"
prove "checkout-real/non-stripe-host-accepted" checkout-gate.mjs \
    "if (run.checkoutHost !== 'checkout.stripe.com') {" "if (false) {"
prove "checkout-real/live-session-accepted" checkout-gate.mjs \
    "if (run.checkoutSessionIsTest !== true) {" "if (false) {"
prove "checkout-real/other-card-accepted" checkout-gate.mjs \
    "if (run.cardTyped !== PUBLISHED_TEST_CARD) {" "if (false) {"
prove "checkout-real/paid-source-unchecked" checkout-gate.mjs \
    "run.paidSource !== 'tenant-member-state' || " ""
prove "checkout-real/tenant-member-status-unchecked" checkout-gate.mjs \
    " || run.tenantMemberStatus !== 'paid'" ""
prove "checkout-real/steps-unchecked" checkout-gate.mjs \
    "if (!Array.isArray(run.steps) || run.steps.join(',') !== STEPS.join(',')) {" "if (false) {"
prove "checkout-real/switch-not-read" checkout-gate.mjs \
    "process.env.CSP_STRIPE_REAL_TEST_MODE === '1'" "false"

# The real test-mode switch itself (csp/proof/real-test-mode.mjs and the gate
# script's wiring of it): each refusal, and the rule that no key is ever shown.
TESTS="$HERE/../proof/real-test-mode.test.mjs"
REAL="../proof/real-test-mode.mjs"
node --test "$TESTS" >/dev/null 2>&1 && echo "BASELINE real-test-mode: GREEN" || { echo "BASELINE real-test-mode: RED"; exit 1; }
prove "real-mode/unset-key-accepted" "$REAL" \
    "if (typeof value !== 'string' || value === '') {" "if (false) {"
prove "real-mode/key-shape-unchecked" "$REAL" \
    "} else if (!rule.pattern.test(value)) {" "} else if (false) {"
prove "real-mode/live-secret-key-accepted" "$REAL" \
    'pattern: /^sk_test_[A-Za-z0-9]+$/,' 'pattern: /^sk_(?:test|live)_[A-Za-z0-9]+$/,'
prove "real-mode/restricted-key-accepted" "$REAL" \
    'pattern: /^sk_test_[A-Za-z0-9]+$/,' 'pattern: /^(?:sk|rk)_test_[A-Za-z0-9]+$/,'
prove "real-mode/live-publishable-key-accepted" "$REAL" \
    'pattern: /^pk_test_[A-Za-z0-9]+$/,' 'pattern: /^pk_(?:test|live)_[A-Za-z0-9]+$/,'
prove "real-mode/webhook-shape-loosened" "$REAL" \
    'pattern: /^whsec_[A-Za-z0-9]+$/,' 'pattern: /^whsec_.*$/,'
prove "real-mode/non-local-tenant-accepted" "$REAL" \
    "|| !LOCAL_HOSTS.has(url.hostname) ||" "||"
prove "real-mode/https-or-portless-tenant-accepted" "$REAL" \
    "url.protocol !== 'http:' || " ""
prove "real-mode/other-card-accepted" "$REAL" \
    "if (digits !== PUBLISHED_TEST_CARD.replaceAll(' ', '')) {" "if (false) {"
prove "real-mode/preflight-skips-tenant-check" "$REAL" \
    "url = assertLocalTenant(origin);" "url = new URL(origin);"
prove "real-mode/preflight-skips-card-check" "$REAL" \
    "assertPublishedTestCard(env.CSP_STRIPE_TEST_CARD);" "void 0;"
prove "real-mode/key-value-echoed-in-refusal" "$REAL" \
    '; it must be ${rule.shape}`' '; it must be ${rule.shape} (got ${value})`'
prove "real-mode/redaction-of-known-values-removed" "$REAL" \
    "out = out.split(secret).join('[REDACTED]')" "void secret"
prove "real-mode/redaction-of-key-shapes-removed" "$REAL" \
    "out = out.replace(pattern, '[REDACTED]');" "void pattern;"
prove "real-mode/checkout-url-fragment-kept" "$REAL" \
    "'\$1#[REDACTED]'" "'\$\$&'"
prove "real-mode/stripe-side-violation-counted-as-tenant" "$REAL" \
    "return document.origin === new URL(tenantOrigin).origin;" "return true;"
prove "real-mode/unplaceable-violation-not-counted" "$REAL" \
    "if (document.protocol !== 'http:' && document.protocol !== 'https:') return true;" "if (false) return true;"
GATE_SH="../gate/csp-checkout-gate.sh"
prove "real-mode/shell-preflight-skipped" "$GATE_SH" \
    "node csp/proof/real-test-mode.mjs preflight" "true"
prove "real-mode/shell-trace-left-on" "$GATE_SH" \
    "set +x
" ":
"
prove "real-mode/shell-webhook-secret-in-argv" "$GATE_SH" \
    "-e WEBHOOK_SECRET
else" "-e \"WEBHOOK_SECRET=\$WEBHOOK_SECRET\"
else"
prove "real-mode/shell-still-starts-the-fake" "$GATE_SH" \
    'if [ -n "$REAL" ]; then
    # No fake' 'if false; then
    # No fake'
prove "real-mode/shell-owner-keys-not-used" "$GATE_SH" \
    'STRIPE_SECRET_KEY="$STRIPE_TEST_SECRET_KEY"' 'STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY"'
prove "real-mode/shell-derive-allowed-with-keys" "$GATE_SH" \
    'if [ -n "$REAL" ] && [ -n "$DERIVE" ]; then' 'if false; then'
prove "real-mode/shell-cleanup-keeps-volumes" "$GATE_SH" \
    'docker rm -fv "$GHOST_NAME"' 'docker rm -f "$GHOST_NAME"'

[ "$FAIL" -eq 0 ] && echo "ALL SABOTAGES DETECTED" || echo "SABOTAGE PROOF FAILED"
exit "$FAIL"
