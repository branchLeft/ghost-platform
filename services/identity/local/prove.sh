#!/usr/bin/env bash
# Proves the reconciler against a real Zitadel and PostgreSQL in local
# containers: two organisations created, a second run changing nothing.
# Creates no cloud resource and leaves nothing behind (volumes included).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
service="$(dirname "$here")"

PROOF_DB_PASSWORD="$(openssl rand -hex 16)"
PROOF_ZITADEL_DB_PASSWORD="$(openssl rand -hex 16)"
PROOF_MASTERKEY="$(openssl rand -hex 16)"
PROOF_ZITADEL_PORT="${PROOF_ZITADEL_PORT:-18080}"
PROOF_STATE_DIR="$(mktemp -d)"
chmod 777 "$PROOF_STATE_DIR"
export PROOF_DB_PASSWORD PROOF_ZITADEL_DB_PASSWORD PROOF_MASTERKEY PROOF_ZITADEL_PORT PROOF_STATE_DIR

compose=(docker compose -f "$here/compose.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$PROOF_STATE_DIR"
}
trap cleanup EXIT

"${compose[@]}" up --detach

# The image has no shell or curl, and its own `ready` subcommand probes over
# TLS, so readiness is read from the published port instead.
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:${PROOF_ZITADEL_PORT}/debug/ready" >/dev/null 2>&1 && [ -s "$PROOF_STATE_DIR/reconciler.pat" ]; then
    ready=1
    break
  fi
  sleep 2
done
[ "${ready:-0}" = 1 ] || { "${compose[@]}" logs zitadel | tail -30; echo "Zitadel did not become ready" >&2; exit 1; }

export ZITADEL_URL="http://localhost:${PROOF_ZITADEL_PORT}"
export ZITADEL_TOKEN_FILE="$PROOF_STATE_DIR/reconciler.pat"
cd "$service"
npx vitest run --config vitest.local.config.ts
