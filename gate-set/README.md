# gate-set: the per-digest gate set

Every candidate digest runs six gates against the image built from it. What each
gate found is written to one record named for the digest. A red gate refuses the
candidate. The record is what the attestation step reads: a candidate is
attested only if `verify` says its record is green, complete and for that digest.

Fixed code. No model, no agent and no person in the path.

## The six gates

They run cheapest first, all of them, so a red candidate still has a full record.

| Gate             | Runs                                                                                              | Passes when                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `overlay-check`  | `sha256sum` inside the image over the four files the Dockerfile overlays or moves aside           | each file's bytes are the committed pin (the build already fails on a mismatch; this is the same result observed in the finished image) |
| `smoke`          | `scripts/smoke-test.sh`                                                                           | the image boots and answers HTTP 200                                            |
| `storage`        | `scripts/test-storage-guard.sh`, then the scanning-storage image tests                            | the storage guard blocks and permits as pinned, and the decorator is wired in the image |
| `theme-scan`     | `themes/image/themes.image.test.mjs`                                                              | every bundled theme renders from the image with no outside origin               |
| `mail`           | `scripts/mail-gate/mail-gate.mjs`                                                                 | a magic link and a newsletter both reach the image's own spool                  |
| `content-policy` | `csp/gate/csp-regression-gate.sh`                                                                 | a hostile `codeinjection_head` did not run under the policy; the theme-hash gate runs inside this script |

A gate passes only by returning `ok: true`. A thrown error, a gate that is not
wired and any other return value are red.

## Running it

```sh
node gate-set/gate-set.mjs run --image ghost-platform:ci --dockerfile Dockerfile --out gate-report
node gate-set/gate-set.mjs verify --report gate-report/gate-report-<64 hex>.json --digest sha256:<64 hex>
```

`run` takes the candidate digest from `--digest`, or from the first `FROM` line of
the Dockerfile given with `--dockerfile` (refused if that line is not pinned by
sha256). It writes `gate-report-<64 hex>.json` into `--out` (a directory) and
exits 0 green, 1 red or refused, 2 unusable input.

`verify` recomputes from the results and never reads the record's own `ok`. It
exits 1 for another digest, a missing or repeated required gate, a red result or
a record that is not a gate report.

The record's `digest`, and each result's `name` and `ok`, are the shape the ring
controller's gate report already takes; the rest (`durationMs`, `detail`,
`totalMs`) are what the release-timing figure is derived from.

## Proof

`node --test gate-set/*.test.mjs` needs no Docker: gates are fakes, and a command
recorder stands in for the real checks. `node gate-set/prove-sabotage.mjs` breaks
each gate's verdict, then the runner's and the verifier's rules, in the real
source, requires the tests to go red, restores, and requires green. Each real
check keeps its own live controls (the mail gate's two red controls, the content
policy gate's `--sabotage` modes, the storage guard's blocked configurations).

## Not covered

- The record is written and checked, but nothing in the image push path reads it
  yet.
- Whether a gate set run is a required check on the digest pull request is a
  repository setting.
