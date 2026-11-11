#!/usr/bin/env bash
# Whether REPLICATION CLIENT alone gives coordinates consistent with the
# snapshot. Same throwaway containers and refusals as prove-snapshot-locking.sh,
# running replication_client_probe.py. Usage, controls, sabotage names, exit
# codes: db/provision/replication_client_probe.md.
set -euo pipefail

export PROOF_PROBE=replication_client_probe.py
exec bash "$(dirname "$0")/prove-snapshot-locking.sh"
