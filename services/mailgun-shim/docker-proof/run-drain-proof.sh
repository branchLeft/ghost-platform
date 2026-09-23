#!/usr/bin/env bash
# Live proof, local Docker sandbox: network isolation + the drain handover
# against a real container topology, a real named-volume-backed sqlite
# queue, and a real crash-before-ack / restart-durability cycle.
#
# Run from services/mailgun-shim/. Requires NODE_AUTH_TOKEN in the
# environment (a GitHub Packages read token for @branchleft/tsconfig) --
# never printed, never written to a file this script creates.
set -euo pipefail

COMPOSE="docker compose -f docker-compose.drain-proof.yml"
DOMAIN="tenant1.example.com"

cleanup() {
  echo "--- tearing down ---"
  $COMPOSE down -v --remove-orphans
}
trap cleanup EXIT

echo "=== build ==="
$COMPOSE build shim

echo "=== up ==="
$COMPOSE up -d

echo "=== waiting for shim healthcheck ==="
for _ in $(seq 1 30); do
  status=$($COMPOSE ps --format json shim | node -e "process.stdin.once('data',d=>{try{console.log(JSON.parse(d).Health)}catch{console.log('')}})" 2>/dev/null || true)
  if [ "$status" = "healthy" ]; then
    echo "shim healthy"
    break
  fi
  sleep 1
done

echo "=== 1. NETWORK ISOLATION: shim has no route out ==="
echo "--- control case first: delivery-stub (on the ordinary bridge network) CAN reach the internet, proving this environment has real egress to fail against ---"
$COMPOSE exec -T delivery-stub node -e "
fetch('http://1.1.1.1', { signal: AbortSignal.timeout(4000) })
  .then(() => console.log('CONTROL: delivery-stub reached 1.1.1.1 -- egress works from an ordinary network'))
  .catch((e) => console.log('CONTROL UNEXPECTED FAILURE:', e.message));
"
echo "--- now the real check: shim (on the internal-only network) CANNOT reach the same address ---"
$COMPOSE exec -T shim node -e "
fetch('http://1.1.1.1', { signal: AbortSignal.timeout(4000) })
  .then(() => console.log('UNEXPECTED: shim reached 1.1.1.1 -- isolation is broken'))
  .catch((e) => console.log('EXPECTED: shim could not reach 1.1.1.1 --', e.message));
"
echo "--- and cannot resolve a public hostname either (no DNS server reachable on an internal network) ---"
$COMPOSE exec -T shim node -e "
require('node:dns').promises.lookup('example.com')
  .then((a) => console.log('UNEXPECTED: shim resolved example.com ->', JSON.stringify(a)))
  .catch((e) => console.log('EXPECTED: shim could not resolve example.com --', e.message));
"

echo "=== 2. register a tenant via docker compose exec (the daemon socket, not the network) ==="
REGISTER_OUT=$($COMPOSE exec -T shim node dist/cli.js register "$DOMAIN")
echo "$REGISTER_OUT"
API_KEY=$(echo "$REGISTER_OUT" | tail -n1)

echo "=== 3. enqueue via the collector (stands in for Ghost, reached over shim_net) ==="
$COMPOSE exec -T collector node collector.mjs enqueue "$DOMAIN" "$API_KEY" "durable-check@example.com" "Durability check"

echo "=== 4. undrained metric shows the message queued ==="
$COMPOSE exec -T collector node collector.mjs metrics

echo "=== 5. CRASH-BEFORE-ACK: collector drains but does not ack ==="
$COMPOSE exec -T collector node collector.mjs drain-no-ack
echo "--- still undrained (held, unacked) ---"
$COMPOSE exec -T collector node collector.mjs metrics

echo "=== 6. lease lapses (SHIM_DRAIN_LEASE_SECONDS=5) -- wait it out ==="
sleep 6

echo "=== 7. re-offered under the same id -- this drain both delivers (again) and acks ==="
$COMPOSE exec -T collector node collector.mjs drain-and-ack
echo "--- undrained is now 0 ---"
$COMPOSE exec -T collector node collector.mjs metrics
echo "--- the delivery stub received the message TWICE, same id both times (at-least-once, exactly what LLD-6 documents) ---"
$COMPOSE exec -T collector node -e "
fetch('http://delivery-stub:3000/deliveries').then(r=>r.json()).then(rows=>{
  console.log('delivery count:', rows.length);
  console.log('ids:', rows.map(r=>r.id));
});
"

echo "=== 8. DURABILITY ACROSS A RESTART: enqueue, restart the shim container, drain survives ==="
$COMPOSE exec -T collector node collector.mjs enqueue "$DOMAIN" "$API_KEY" "restart-check@example.com" "Restart check"
$COMPOSE restart shim
for _ in $(seq 1 30); do
  status=$($COMPOSE ps --format json shim | node -e "process.stdin.once('data',d=>{try{console.log(JSON.parse(d).Health)}catch{console.log('')}})" 2>/dev/null || true)
  [ "$status" = "healthy" ] && break
  sleep 1
done
$COMPOSE exec -T collector node collector.mjs metrics
$COMPOSE exec -T collector node collector.mjs drain-and-ack
$COMPOSE exec -T collector node collector.mjs metrics

echo "=== 9. UNAUTHENTICATED DRAIN IS REFUSED ==="
echo -n "no token -> "
$COMPOSE exec -T collector node collector.mjs drain-unauthenticated
echo -n "wrong token -> "
$COMPOSE exec -T collector node collector.mjs drain-unauthenticated not-the-real-token

echo "=== ALL STEPS COMPLETE ==="
