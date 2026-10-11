# assert-broker-contract-generated.py

## Why this check exists

The broker's server and its control-plane push client run generated code. That
code is committed under `services/broker/src/generated/` (the reasons are in
`services/broker/src/app.md`, under "generated server"), so a spec edit that
was not followed by a regeneration would leave the broker running code for an
API that no longer exists, and the package published from the same spec would
differ from what the broker was tested against.

This script is the missing comparison. It takes the `src` directory
`speckify build` wrote for the contract and requires the committed tree to be
exactly that, file for file and byte for byte, below the two header lines the
script itself adds. A missing file, an extra file and an edited file are each
reported.

It runs in `speckify.yml`, on every pull request that touches the spec or the
generated tree, and again immediately before a publish, so a package is never
published from a spec the broker is not running.

## Regenerating

`--write` replaces the committed tree with a fresh generation. The generated
files are never edited by hand: a hand edit is exactly what this check refuses.

## Self-test

`--self-test` builds a source tree and a committed tree in a temporary
directory and asserts the matcher finds an edit, a deletion, an addition and a
missing header, and that a clean tree passes. A comparison that has quietly
stopped comparing passes every tree, so the self-test is the control case.
