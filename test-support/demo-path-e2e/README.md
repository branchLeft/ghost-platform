# demo-path-e2e

The demo path, driven as a prospect would drive it, as one run in CI. The run
is a list of stages in the order a prospect meets them; each ends `passed`,
`failed`, `not_run` or `pending`, and the verdict is read from that list.

```text
python3 -m demo_path_e2e run --gate-image demo-gate:ci --report report.json
python3 -m demo_path_e2e prove-sabotage --gate-image demo-gate:ci --report-dir reports
python3 -m demo_path_e2e summary report.json
python3 -m demo_path_e2e stages
```

Run from this directory. `.github/workflows/demo-path-e2e.yml` runs the first
two on every change to what they read, builds the gate image first, and shows
the summary and uploads the JSON reports, so the result is read from the
workflow run.

## The environment

A test environment that exists only for the run, as containers on the machine
that runs it. Nothing here reaches a public slot, a host or a credential.

- The stand-in colours (`scripts/demo-edge-proof/sim.mjs`) own a network
  namespace; the gate and Caddy join it, as the edge, gate and colours share one
  on the demo host.
- The gate is the real image, reading the slots file and the lease directory in
  the shapes the broker writes them.
- Caddy loads the Caddyfile that `demo-host/provision/render_demo_site.py`
  renders for a gated slot, the production block with a local certificate
  authority in place of the DNS-01 wildcard. The visitor trusts that authority
  and checks the certificate; verification is never switched off.

Until the broker's reconcile and the lifecycle worker run inside it, the
environment plays the broker's two writes: the slot's passphrase hash and its
lease record.

## The stages

| Stage           | State     | What it holds, or what is missing                                         |
| --------------- | --------- | ------------------------------------------------------------------------- |
| `landing`       | pending   | no landing page serves the path yet                                       |
| `front-door`    | pending   | no form takes a stranger's details yet                                    |
| `provisioning`  | pending   | the lifecycle worker that runs a claim to a live slot is not built        |
| `arrival`       | pending   | no single-use arrival link exists yet                                     |
| `admin-sign-in` | pending   | needs the arrival link and a real Ghost behind the gate                   |
| `gated-read`    | built     | a stranger is refused everywhere; the right passphrase reads the slot     |
| `extension`     | pending   | no extension request exists yet                                           |
| `expiry`        | pending   | no reaper drives expiry yet                                               |
| `recycle`       | built     | the next tenancy gets the slot; the last one's cookie and passphrase fail |

A pending stage is listed in every report, so a green run is a green slice and
never the whole path. `run --require-complete` fails while any stage is pending;
the workflow switches it on when the last stage is built.

## The control case

`prove-sabotage` breaks each built stage in turn, in the real environment, and
requires the run to be red at that stage and at no other: every built stage
before it passed, it failed, and every built stage after it was not run.

| Sabotage                      | What is broken                                                  |
| ----------------------------- | --------------------------------------------------------------- |
| `gated-read:wrong-hash`       | the slot's hash on file is not the issued passphrase's          |
| `gated-read:exempt-ghost`     | the edge proxies `/ghost/*` straight to a colour, outside gate  |
| `recycle:hash-not-rotated`    | a recycle writes the next lease and keeps the last tenancy hash |

`test_registry.py` fails unless every built stage has a sabotage and every
sabotage names a built stage, so a stage cannot be added without its control.

## Adding a stage

Give its entry in `demo_path_e2e/stages.py` a `run`, add the sabotage that
breaks it in the real environment to `sabotage.py` and `environment.py`, and
move its row above to built. The unit tests drive every built stage against an
in-memory edge (`test_support.py`) and show each fault red there before the
real environment is asked.
