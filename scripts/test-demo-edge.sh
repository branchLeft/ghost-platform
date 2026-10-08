#!/bin/sh
# Proves the demo edge live: the Caddyfile rendered by
# demo-host/provision/render_demo_site.py, loaded by a real Caddy beside the
# real demo gate image, with two stand-in colours and a stand-in health
# router. See test-demo-edge.md#what-this-proves.
#
# Usage: ./scripts/test-demo-edge.sh <gate-image-tag>
# Docker use is capped by the standing grant; the caller holds a proof slot.
set -eu

GATE_IMAGE="${1:?usage: test-demo-edge.sh <gate-image-tag>}"
CADDY_IMAGE="caddy:2.11.4-alpine"
NODE_IMAGE="node:22-alpine"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="$$"
SIM="demo-edge-proof-sim-$RUN_ID"
GATE="demo-edge-proof-gate-$RUN_ID"
CADDY="demo-edge-proof-caddy-$RUN_ID"
HOST="slot0.demo.test"
PASS="proof-passphrase-slot-0"
LEASE="01J9F4Q7ZC3M8V2K6X0R5T1B9D"
PROOF="$HERE/scripts/demo-edge-proof"

WORK="$(mktemp -d)"
chmod 0755 "$WORK"
mkdir -m 0755 "$WORK/config" "$WORK/leases" "$WORK/drain"
FAILURES=0

cleanup() {
    docker rm -f "$CADDY" "$GATE" "$SIM" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }
expect() {
    if [ "$3" = "$2" ]; then pass "$1 ($3)"; else fail "$1: expected $2, got $3"; fi
}
# probe <method> <path> [cookie|-] [form-body] -> status, headers JSON, body (3 lines)
probe() {
    docker run --rm --network "container:$SIM" -v "$PROOF:/proof:ro" "$NODE_IMAGE" \
        node /proof/probe.mjs "$HOST" "$@"
}
status() { probe "$@" | sed -n 1p; }
body() { probe "$@" | sed -n '3,$p'; }
header() { name="$1"; shift; probe "$@" | sed -n 2p | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s||'{}')['$name']??'')))" 2>/dev/null || true; }

echo "Gate image under test: $GATE_IMAGE"
echo "--- fixtures and the rendered Caddyfile ---"
head -c 32 /dev/urandom > "$WORK/config/key"
chmod 0644 "$WORK/config/key"
HASH="$(printf %s "$PASS" | docker run --rm -i "$GATE_IMAGE" node dist/hashCli.js)"
if [ "${DEMO_EDGE_PROOF_LEGACY_IMAGE:-}" = "1" ]; then
    # A local image built before the lease record carried hashId (render-core
    # 0.1.0): its gate reads a record without one. CI always builds fresh and
    # never sets this.
    echo "  WARNING: legacy gate image, lease record carries no hashId"
    LEASE_JSON="{\"slot\":\"0\",\"lease\":\"$LEASE\"}"
else
    HASH_ID="$(docker run --rm "$GATE_IMAGE" node -e '
      import("@branchleft/ghost-platform-render-core").then((m) => process.stdout.write(m.hashIdOf(process.argv[1])));
    ' "$HASH")"
    LEASE_JSON="{\"slot\":\"0\",\"lease\":\"$LEASE\",\"hashId\":\"$HASH_ID\"}"
fi
printf '{"slots":[{"host":"%s","slot":"0","gate":{"kind":"passphrase","argon2idHash":"%s"}}]}' "$HOST" "$HASH" > "$WORK/config/slots.json"
chmod 0644 "$WORK/config/slots.json"
printf '%s' "$LEASE_JSON" > "$WORK/leases/0.json"
chmod 0644 "$WORK/leases/0.json"
sed "s/demo-host.example.test/$HOST/; s/k7m-vale-bright.demo-domain.example.test/$HOST/" \
    "$HERE/render-core/test/golden/demo.edge.json" > "$WORK/edge.json"
# Proof-only global options: a local CA and no trust-store install.
python3 "$HERE/demo-host/provision/render_demo_site.py" --slot 0 --edge-json "$WORK/edge.json" \
    | sed 's/^\tadmin off$/\tadmin off\n\tlocal_certs\n\tskip_install_trust\n\tauto_https disable_redirects/' \
    > "$WORK/Caddyfile"
if [ "${DEMO_EDGE_PROOF_SABOTAGE:-}" = "exempt-ghost" ]; then
    # Sabotage: exempt /ghost/* from forward_auth. The "every path is gated"
    # probes must go red (see test-demo-edge.md).
    sed 's|^\thandle {$|\thandle /ghost/* {\n\t\treverse_proxy 127.0.0.1:9300\n\t}\n\thandle {|' "$WORK/Caddyfile" > "$WORK/Caddyfile.sab"
    mv "$WORK/Caddyfile.sab" "$WORK/Caddyfile"
    echo "  SABOTAGE: /ghost/* exempted from forward_auth"
fi
echo "  rendered $(wc -l < "$WORK/Caddyfile") lines for $HOST"

echo "--- starting the colours, the gate and Caddy (one network namespace, as on the host) ---"
docker run -d --name "$SIM" -v "$PROOF:/proof:ro" -v "$WORK/drain:/drain" "$NODE_IMAGE" \
    node /proof/sim.mjs >/dev/null
docker run -d --name "$GATE" --network "container:$SIM" \
    -v "$WORK/config:/etc/demo-gate:ro" -v "$WORK/leases:/run/demo-leases:ro" \
    -e GATE_SIGNING_KEY_FILE=/etc/demo-gate/key \
    -e GATE_SLOTS_FILE=/etc/demo-gate/slots.json \
    -e GATE_LEASE_DIR=/run/demo-leases \
    -e GATE_TRUSTED_PROXIES=127.0.0.1 \
    -e PORT=8080 -e LISTEN_HOST=127.0.0.1 \
    "$GATE_IMAGE" >/dev/null
docker run -d --name "$CADDY" --network "container:$SIM" \
    -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null

for _ in $(seq 1 30); do
    if [ "$(status GET /)" = "401" ]; then break; fi
    sleep 1
done

echo "--- 1. no cookie: every path answers 401 ---"
for path in / /ghost/ /ghost/api/admin/ /ghost/api/admin/settings/ /rss/ /sitemap.xml /robots.txt /members/api/member/ /ghost/api/admin/members/upload/; do
    expect "GET $path with no cookie" 401 "$(status GET "$path")"
done
for method in POST PUT DELETE; do
    expect "$method /ghost/api/admin/session with no cookie" 401 "$(status $method /ghost/api/admin/session)"
done
expect "POST members upload with no cookie (gate answers before the refusal)" 401 \
    "$(status POST /ghost/api/admin/members/upload/)"
if probe GET /ghost/ | grep -q colour-; then fail "a colour's body leaked with no cookie"; else pass "no colour's body reaches a visitor with no cookie"; fi
expect "noindex on the refusal" "noindex, nofollow" "$(header x-robots-tag GET /)"

echo "--- 2. log in ---"
LOGIN="$(probe POST /__gate/login - "passphrase=$PASS&r=/ghost/")"
expect "login" 303 "$(echo "$LOGIN" | sed -n 1p)"
COOKIE="$(echo "$LOGIN" | sed -n 2p | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s)['set-cookie']||[];process.stdout.write(String(c[0]||'').split(';')[0])})")"
[ -n "$COOKIE" ] && pass "cookie issued" || fail "no cookie issued"

echo "--- 3. with the cookie the site serves, and the policy is on every response ---"
expect "GET / with the cookie" 200 "$(status GET / "$COOKIE")"
expect "GET /ghost/api/admin/ with the cookie" 200 "$(status GET /ghost/api/admin/ "$COOKIE")"
expect "noindex with the cookie" "noindex, nofollow" "$(header x-robots-tag GET / "$COOKIE")"
CSP="$(header content-security-policy-report-only GET / "$COOKIE")"
case "$CSP" in "default-src 'self'"*) pass "content policy header present (report-only: no derived hash set in this fixture)" ;; *) fail "no content policy header: '$CSP'" ;; esac

echo "--- 4. the members import is refused; the export is not ---"
expect "POST /ghost/api/admin/members/upload/ with the cookie" 403 \
    "$(status POST /ghost/api/admin/members/upload/ "$COOKIE")"
expect "GET /ghost/api/admin/members/upload/ with the cookie" 200 \
    "$(status GET /ghost/api/admin/members/upload/ "$COOKIE")"
expect "POST to another admin path with the cookie is not refused by the edge" 200 \
    "$(status POST /ghost/api/admin/session "$COOKIE")"

echo "--- 5. per-colour health: draining the serving colour moves traffic, no reload ---"
expect "colour a serves first" "colour-a GET /" "$(body GET / "$COOKIE")"
touch "$WORK/drain/a"
MOVED=no
for _ in $(seq 1 15); do
    if [ "$(body GET / "$COOKIE")" = "colour-b GET /" ]; then MOVED=yes; break; fi
    sleep 1
done
expect "traffic moved to colour b after draining a" yes "$MOVED"
rm -f "$WORK/drain/a"
touch "$WORK/drain/b"
BACK=no
for _ in $(seq 1 15); do
    if [ "$(body GET / "$COOKIE")" = "colour-a GET /" ]; then BACK=yes; break; fi
    sleep 1
done
expect "and back to colour a when b drains (the check tells the colours apart)" yes "$BACK"

if [ "$FAILURES" -ne 0 ]; then
    echo "$FAILURES check(s) failed"
    exit 1
fi
echo "all checks passed"
