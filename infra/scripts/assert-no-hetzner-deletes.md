# assert-no-hetzner-deletes.py

## Module overview

Ported from shared-infra's guard of the same name so the hosts stack's CI
apply path carries the same gate as the estate stacks it builds on; the
coverage map below is this repository's own. Consolidating the two copies
rides with the shared guard packaging effort.

What this cannot prove, both limits real:

1. `pulumi preview` compares the program to Pulumi *state*, never to live
   Hetzner. A resource already deleted out of band still reads as unchanged.
   This gate answers "will this apply destroy something", not "is the estate
   intact".

2. A resource that migrates out of a program dir leaves the plan check
   intact but makes the coverage map here stale. `--verify-coverage` fails
   until the map is updated consciously, so the move is a reviewed edit
   rather than a silent erosion.
