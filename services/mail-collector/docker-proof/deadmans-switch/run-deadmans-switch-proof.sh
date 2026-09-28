#!/usr/bin/env bash
# Live proof, local Docker sandbox: a real healthchecks/healthchecks
# instance standing in for the hosted Healthchecks.io, and the real
# built createDeadMansSwitch (dist/heartbeat.js) driving it -- the dead
# man's switch's own Done-means checklist, run against real processes
# rather than mocks.
#
# Run from services/mail-collector/, after `npm run build`.
set -euo pipefail

COMPOSE="docker compose -f docker-compose.deadmans-switch-proof.yml"

cleanup() {
  echo "--- tearing down ---"
  $COMPOSE down -v --remove-orphans
}
trap cleanup EXIT

echo "=== up ==="
$COMPOSE up -d

echo "=== waiting for healthchecks to be healthy ==="
for _ in $(seq 1 30); do
  status=$($COMPOSE ps --format '{{.Health}}' healthchecks 2>/dev/null || true)
  if [ "$status" = "healthy" ]; then
    echo "healthchecks healthy"
    break
  fi
  sleep 1
done

echo "=== setup: one project, two throwaway checks ==="
setup_output=$($COMPOSE exec -T healthchecks python3 manage.py shell < docker-proof/deadmans-switch/hc_setup.py)
echo "$setup_output"

export PROOF_API_KEY=$(echo "$setup_output" | grep '^PROOF_API_KEY=' | cut -d= -f2-)
export PROOF_IDLE_CHECK_CODE=$(echo "$setup_output" | grep '^PROOF_IDLE_CHECK_CODE=' | cut -d= -f2-)
export PROOF_STOPPED_CHECK_CODE=$(echo "$setup_output" | grep '^PROOF_STOPPED_CHECK_CODE=' | cut -d= -f2-)
export PROOF_SITE_ROOT=http://localhost:8095

echo "=== running the real dead man's switch against the real instance ==="
node docker-proof/deadmans-switch/proof-harness.mjs
