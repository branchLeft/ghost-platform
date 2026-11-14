# assert-contracts-generated.py

## Why this check exists

Two services run Speckify-generated code, committed beside their specs:

| Contract | Spec | Committed tree |
| --- | --- | --- |
| `broker-api` | `services/broker/openapi.yaml` | `services/broker/src/generated/` |
| `provisioning-api` | `services/provisioning-controller/openapi.yaml` | `services/provisioning-controller/src/generated/` |

The broker's server and its control-plane push client run their generated code
(the reasons are in `services/broker/src/app.md`, under "generated server"). The
portal and the owner console import the provisioning client, and the in-memory
mock serves through the provisioning server. A spec edit that was not followed
by a regeneration would leave each running code for an API that no longer
exists, and the package published from the same spec would differ from what the
service was tested against.

This script is the missing comparison. It takes the directory `speckify build`
wrote (`.speckify/out`) and, for each contract, requires the committed tree to
be exactly `<out>/<name>/typescript/src`, file for file and byte for byte, below
the two header lines the script itself adds. A missing file, an extra file and
an edited file are each reported, under the contract's name.

The table of contracts in the script and the contracts in `speckify.yaml` must
name the same set. A contract added to `speckify.yaml` with no committed tree
registered here is itself a failure, so a new generated tree cannot be left
unchecked.

It runs in `speckify.yml`, on every pull request that touches a spec, a
generated tree or this script, and again immediately before a publish, so a
package is never published from a spec its service is not running.

## Regenerating

```sh
speckify build
python3 scripts/assert-contracts-generated.py --write .speckify/out
```

`--write` replaces the committed trees with a fresh generation (add
`--contract <name>` for one). The generated files are never edited by hand: a
hand edit is exactly what this check refuses.

## Self-test

`--self-test` builds a source tree and a committed tree in a temporary
directory and asserts the matcher finds an edit, a deletion, an addition and a
missing header, that a clean tree passes, and that the registry check finds a
contract with no tree and a tree with no contract. A comparison that has quietly
stopped comparing passes every tree, so the self-test is the control case.
