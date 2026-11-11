#!/bin/sh
# Sabotage proof for the gates' verdict logic (the theme-hash, regression and
# checkout gates, and the payment-origin derivation that feeds the policy): for
# each, mutate the real source in place, require its tests to go RED, restore
# it, require them GREEN. A mutation whose target string is not found aborts
# (a sabotage that changed nothing proves nothing). Needs render-core built.
# The live-browser sabotages (policy removed, hashes removed, Stripe origin
# removed) are in csp-regression-gate.sh --sabotage=... and
# csp-checkout-gate.py --sabotage=...; see their .md files.
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

[ "$FAIL" -eq 0 ] && echo "ALL SABOTAGES DETECTED" || echo "SABOTAGE PROOF FAILED"
exit "$FAIL"
