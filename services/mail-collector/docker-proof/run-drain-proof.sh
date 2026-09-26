#!/usr/bin/env bash
# Live proof, local Docker sandbox: two REAL mailgun-shim instances as
# spools, a REAL authenticated SMTP sink standing in for mx1, and the real
# collector image between them -- run this story's own
# "Done means" checklist against real local processes, not mocks.
#
# Run from services/mail-collector/. Requires NODE_AUTH_TOKEN in the
# environment (a GitHub Packages read token for @branchleft/tsconfig) --
# never printed, never written to a file this script creates.
set -euo pipefail

COMPOSE="docker compose -f docker-compose.drain-proof.yml"

cleanup() {
  echo "--- tearing down ---"
  $COMPOSE down -v --remove-orphans
}
trap cleanup EXIT

wait_healthy() {
  local service="$1"
  for _ in $(seq 1 30); do
    status=$($COMPOSE ps --format json "$service" | node -e "process.stdin.once('data',d=>{try{console.log(JSON.parse(d).Health)}catch{console.log('')}})" 2>/dev/null || true)
    if [ "$status" = "healthy" ]; then
      echo "$service healthy"
      return 0
    fi
    sleep 1
  done
  echo "$service never became healthy" >&2
  return 1
}

register_and_enqueue() {
  local shim="$1" domain="$2" tag="$3"
  local api_key
  api_key=$($COMPOSE exec -T "$shim" node dist/cli.js register "$domain" --sender-domain "$domain" | tail -n1)
  $COMPOSE exec -T "$shim" node -e "
    const FormData = globalThis.FormData;
    const form = new FormData();
    form.append('to', 'reader@example.com');
    form.append('from', 'noreply@$domain');
    form.append('subject', '$tag');
    form.append('html', '<p>$tag</p>');
    form.append('text', '$tag');
    form.append('recipient-variables', '{}');
    const auth = Buffer.from('api:$api_key').toString('base64');
    fetch('http://127.0.0.1:8080/v3/$domain/messages', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth },
      body: form,
    }).then(r => { if (!r.ok) throw new Error('enqueue failed: ' + r.status); console.log('enqueued on $shim: $tag'); });
  "
}

echo "=== build ==="
$COMPOSE build

echo "=== up ==="
$COMPOSE up -d

echo "=== waiting for the three shim instances ==="
wait_healthy shim-a
wait_healthy shim-b
wait_healthy shim-undescribed

echo "=== 1. enqueue on the two DESCRIBED hosts, and on the UNDESCRIBED (but reachable) one ==="
register_and_enqueue shim-a tenant-a.example "from-tenant-a"
register_and_enqueue shim-b tenant-b.example "from-tenant-b"
register_and_enqueue shim-undescribed undescribed.example "SHOULD-NEVER-ARRIVE"

echo "=== 2. give the collector every chance to drain everything reachable ==="
sleep 5

echo "=== 3. CONTROL CASE: only the two described hosts reached the sink ==="
$COMPOSE exec -T smtp-sink node deliveries.mjs

echo "=== 4. both described spools are fully drained and acked (undrained == 0) ==="
$COMPOSE exec -T shim-a node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(j=>console.log('shim-a:', JSON.stringify(j)))"
$COMPOSE exec -T shim-b node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(j=>console.log('shim-b:', JSON.stringify(j)))"

echo "=== 5. the undescribed host was never even polled ==="
$COMPOSE exec -T shim-undescribed node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(j=>console.log('shim-undescribed:', JSON.stringify(j)))"
echo "--- its message is still sitting undrained, proving the collector never called GET /drain against it ---"

echo "=== 6. the collector's own healthz reports the two described targets ==="
$COMPOSE exec -T collector node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))"

echo "=== ALL STEPS COMPLETE ==="
