#!/bin/sh
# Sabotage proof for the two #1251 gates' verdict logic: for each gate,
# mutate the real source in place, require the gate's tests to go RED, restore
# it, require them GREEN. A mutation whose target string is not found aborts
# (a sabotage that changed nothing proves nothing). Needs render-core built.
# The live-browser sabotages (policy removed, hashes removed) are in
# csp-regression-gate.sh --sabotage=...; see csp-regression-gate.md.
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

prove() { # label, file, from, to
    label="$1"; file="$2"; from="$3"; to="$4"
    cp "$file" "$file.orig"
    trap 'mv -f "$file.orig" "$file"' EXIT INT TERM
    mutate "$file" "$from" "$to" || { mv -f "$file.orig" "$file"; exit 3; }
    if node --test "$HERE" >/dev/null 2>&1; then
        echo "SABOTAGE $label: NOT DETECTED (tests stayed green)"; FAIL=1
    else
        echo "SABOTAGE $label: RED"
    fi
    mv -f "$file.orig" "$file"
    trap - EXIT INT TERM
    if node --test "$HERE" >/dev/null 2>&1; then
        echo "RESTORED $label: GREEN"
    else
        echo "RESTORED $label: STILL RED"; FAIL=1
    fi
}

node --test "$HERE" >/dev/null 2>&1 && echo "BASELINE: GREEN" || { echo "BASELINE: RED"; exit 1; }

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
prove "theme-hash/report-only-flag-unchecked" theme-hash-gate.mjs  "if (record.flag !== REPORT_ONLY_FLAG)" "if (false)"
prove "theme-hash/enforcing-mode-unchecked" theme-hash-gate.mjs  "if (edge.contentSecurityPolicyMode !== 'enforcing') {" "if (false) {"

[ "$FAIL" -eq 0 ] && echo "ALL SABOTAGES DETECTED" || echo "SABOTAGE PROOF FAILED"
exit "$FAIL"
