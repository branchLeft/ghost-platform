# csp/gate: the theme-hash and content-policy regression gates

Two standalone gates owed by LLD-5 to LLD-3's gate set
(`ghost-platform-docs/19-try-it-now-design/03-harness.html` §05, row "Theme
CSP hashes"; `05-gate-and-edge.html` §04). Marks: the CSP regression is a
standing check, and a theme whose hashes cannot be computed fails to
report-only rather than failing the tenant (both load-bearing).

**What is stubbed.** The slot 0 gate-set runner
has no code, and LLD-3 specifies no runner interface, only assertion plus
control case. So each gate follows the sibling pattern
(`scripts/test-node-env-gate.sh`): a standalone check whose exit status is the
verdict. Nothing here registers with a runner, runs on the demo host, or is
ordered in the gate sequence; that wiring waits on that runner.

## theme-hash-gate.mjs

`admitTheme` derives the hash set (`csp/derive/`) and returns the `ThemeCsp`
plus the record to store: enforcing with the hashes, or report-only with the
flag `csp-hashes-unavailable`. `verifyAdmission` checks the real render-core
edge block agrees. An empty computed set is treated as uncomputable (incidental
choice). CLI: `GHOST_ORIGIN=... CSP_DERIVE_PATHS=/,/p/ node csp/gate/theme-hash-gate.mjs`.

## csp-regression-gate.mjs / .sh

`judgeRegression` is the verdict on `csp/proof/capture-csp.mjs` output: injected
script did not run, Portal's email field rendered, exactly one violation and it
is the inline-script attack. `csp-regression-gate.sh` runs it live (Docker,
Chromium via `csp/proof`). `--sabotage=no-policy` and `--sabotage=no-hashes`
serve the policy broken and must exit non-zero. It prints `GATE_TIMING`
seconds for LLD-4's release-timing claim (measured on a workstation, not the
demo host).

Where it runs (the issue's open question) is not decided here: a headless
Chromium beside seven slots is unmeasured; this gate needs only an origin to
browse, so it can run from the control side. It never needs egress from the
demo host.

## Tests

`node --test csp/gate/*.test.mjs` (needs `render-core` built). `csp/gate/prove-gates.sh`
mutates each verdict rule and requires the tests to go red, then green.

## Running the live gate

Needs Docker, `csp/proof`'s own `npm install` for Playwright, and render-core built.

```sh
./csp/gate/csp-regression-gate.sh [--sabotage=no-policy|no-hashes] [IMAGE]
```

IMAGE is a built platform image; omitted, one is built from the repo root.
`--sabotage` serves the policy broken on purpose and the gate must exit non-zero:

- `no-policy`: no Content-Security-Policy header, so the injected script runs.
- `no-hashes`: `script-src 'self'` enforced with no hash allowance, so Ghost's
  own inline blocks are blocked as well as the attack.
