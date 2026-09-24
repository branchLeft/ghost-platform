#!/bin/sh
# Proves the on-demand TLS ask endpoint's contract live: a real Caddy with
# on_demand_tls in front of it, asking before every issuance, and a real
# ACME test CA (Let's Encrypt's own Pebble, run through the actual ACME v2
# protocol -- order, authorization, HTTP-01 challenge, finalize, download)
# rather than Caddy's built-in internal CA. Design:
# ghost-platform-docs/19-try-it-now-design/05-gate-and-edge.html §02 (E1-E5).
#
# What it shows, each against the real edge rather than the service alone:
#   - a served hostname completes the TLS handshake and Pebble genuinely
#     issues it a certificate (the leaf's issuer is a Pebble Intermediate
#     CA, not Caddy's own local_certs authority)
#   - an unserved hostname never gets that far: the handshake itself fails,
#     with no HTTP status at all on Caddy's side (LLD-5 E1) -- proven by a
#     failed TLS connect, not a 4xx response, because there is no response
#     to have a status
#   - the ask endpoint's own contract holds when queried directly: 200 for
#     served, 403 for unserved-under-the-ceiling, 429 once a burst of
#     distinct unknown names exceeds it (LLD-5 E3), 400 for a malformed
#     domain parameter
#   - Caddy's own log shows an issuance attempt for the served hostname and
#     none at all for the refused one -- the ask happens before Caddy would
#     even try
#
# Pebble's validation authority is configured PEBBLE_VA_ALWAYS_VALID=0 (the
# default): it performs a real HTTP-01 challenge round-trip against this
# Caddy, resolved through pebble-challtestsrv's fake DNS (every name
# defaults to the Caddy container's address -- there is no real DNS zone
# for the fixture hostnames below, nor does this proof need one).
#
# Usage:
#   docker build -f services/odask/Dockerfile --secret id=node_auth_token,env=NODE_AUTH_TOKEN -t odask:local .
#   ./scripts/test-odask.sh odask:local
set -eu

ODASK_IMAGE="${1:?usage: test-odask.sh <odask-image-tag>}"
PEBBLE_IMAGE="ghcr.io/letsencrypt/pebble:2.7.0"
CHALLTESTSRV_IMAGE="ghcr.io/letsencrypt/pebble-challtestsrv:2.7.0"
CADDY_IMAGE="caddy:2.11.4-alpine"
CURL_IMAGE="curlimages/curl:8.16.0"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROOF="$HERE/services/odask/proof"
RUN_ID="$$"
NET="odask-proof-$RUN_ID"
SUBNET="10.231.91.0/24"
CHALLTESTSRV_IP="10.231.91.2"
PEBBLE_IP="10.231.91.3"
CADDY_IP="10.231.91.4"
ODASK_IP="10.231.91.5"

# D10: the platform's own default subdomain zone and its demo domain.
BASE_DOMAIN="sites.publicpress.co.uk"
ALLOWED_HOST="tenant-one.$BASE_DOMAIN"
DISALLOWED_HOST="evil.trypublicpress.co.uk"

CHALLTESTSRV="odask-proof-challtestsrv-$RUN_ID"
PEBBLE="odask-proof-pebble-$RUN_ID"
CADDY="odask-proof-caddy-$RUN_ID"
ODASK="odask-proof-odask-$RUN_ID"

WORK="$(mktemp -d)"
mkdir -m 0755 "$WORK/descriptors"
cat >"$WORK/descriptors/tenant-one.json" <<EOF
{"kind": "tenant", "hostname": {"kind": "ours", "sub": "tenant-one", "gated": false}}
EOF
FAILURES=0

cleanup() {
    docker rm -f "$CADDY" "$PEBBLE" "$CHALLTESTSRV" "$ODASK" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }
expect() {
    if [ "$3" = "$2" ]; then pass "$1 ($3)"; else fail "$1: expected $2, got $3"; fi
}

ask_status() {
    # ask_status <domain> -> the ask endpoint's own HTTP status, queried
    # directly rather than through Caddy, so the four-way status contract
    # (200/403/429/400) is provable on its own regardless of what Caddy
    # does with any particular one of them.
    docker run --rm --network "$NET" "$CURL_IMAGE" -s -o /dev/null -w '%{http_code}' \
        "http://odask:9000/?domain=$1"
}

echo "== boot: DNS stub, Pebble, odask, Caddy =="
docker network create --subnet "$SUBNET" "$NET" >/dev/null

# Every name resolves to Caddy's address by default -- there is no real DNS
# zone for these fixture hostnames, and none is needed: Pebble's validation
# authority only needs *a* reachable address to challenge, and in this
# topology that is always the one edge terminating TLS.
docker run -d --name "$CHALLTESTSRV" --network "$NET" --ip "$CHALLTESTSRV_IP" \
    "$CHALLTESTSRV_IMAGE" -defaultIPv4 "$CADDY_IP" -defaultIPv6 "" -http01 "" -https01 "" -tlsalpn01 "" >/dev/null

docker run -d --name "$PEBBLE" --network "$NET" --ip "$PEBBLE_IP" --network-alias pebble \
    -v "$PROOF/pebble-config.json:/test/config/pebble-config.json:ro" \
    "$PEBBLE_IMAGE" -config /test/config/pebble-config.json -dnsserver "$CHALLTESTSRV_IP:8053" >/dev/null

# BIND_HOST is the container's own fixed address, not 0.0.0.0 -- config.ts
# refuses a wildcard bind outright, and this proof's own point is to show
# what a correctly bound deployment looks like, not merely what odask
# happens to accept.
docker run -d --name "$ODASK" --network "$NET" --ip "$ODASK_IP" --network-alias odask \
    -e "BIND_HOST=$ODASK_IP" -e "DESCRIPTOR_DIR=/descriptors" -e "BASE_DOMAIN=$BASE_DOMAIN" \
    -e "OWNED_DOMAINS=publicpress.co.uk,trypublicpress.co.uk" \
    -e "RATE_LIMIT_CAPACITY=10" -e "RATE_LIMIT_REFILL_PER_SECOND=1" \
    -v "$WORK/descriptors:/descriptors:ro" \
    "$ODASK_IMAGE" >/dev/null

docker run -d --name "$CADDY" --network "$NET" --ip "$CADDY_IP" --network-alias caddy \
    -v "$PROOF/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$PROOF/pebble.minica.pem:/pebble.minica.pem:ro" \
    "$CADDY_IMAGE" >/dev/null

# Give every process a moment to finish booting before the first request.
sleep 2

echo "== ask endpoint contract, queried directly =="
expect "served hostname" 200 "$(ask_status "$ALLOWED_HOST")"
expect "unserved hostname, under the ceiling" 403 "$(ask_status "$DISALLOWED_HOST")"
expect "malformed domain parameter" 400 \
    "$(docker run --rm --network "$NET" "$CURL_IMAGE" -s -o /dev/null -w '%{http_code}' 'http://odask:9000/?domain=-bad-.example')"
expect "missing domain parameter" 400 \
    "$(docker run --rm --network "$NET" "$CURL_IMAGE" -s -o /dev/null -w '%{http_code}' 'http://odask:9000/')"

echo "== a burst of unknown names past the ceiling (LLD-5 E3) =="
# odask above is started with a deliberately small ceiling (10, refilling at
# 1/s) for this check only -- the production default (50 at 10/s) would
# require an unrealistically fast client to observably trip in a shell
# loop, and the property under test is "the ceiling is enforced at all",
# not any particular tuning of it (config.test.ts already covers the
# tuning). All 30 requests run from inside one curl container so the
# request cadence reflects real burst timing rather than this script's own
# per-`docker run` overhead. Caddy no longer throttles on-demand issuance
# itself at all (LLD-5 E3), so this ceiling is the only one there is.
burst_log="$WORK/burst.log"
docker run --rm --network "$NET" "$CURL_IMAGE" sh -c '
  i=0
  while [ "$i" -lt 30 ]; do
    curl -s -o /dev/null -w "%{http_code}\n" "http://odask:9000/?domain=burst-$i.trypublicpress.co.uk"
    i=$((i + 1))
  done
' >"$burst_log"
bad="$(grep -cvE '^403$|^429$' "$burst_log" || true)"
seen_429="$(grep -c '^429$' "$burst_log" || true)"
if [ "$bad" -eq 0 ]; then pass "every burst response was 403 or 429, never 200"; else fail "$bad burst response(s) were neither 403 nor 429"; fi
if [ "$seen_429" -gt 0 ]; then pass "ceiling trips within a 30-request burst of distinct unknown names ($seen_429 x 429)"; else fail "ceiling never tripped across 30 distinct unknown names"; fi

echo "== real Caddy + real Pebble: the served hostname =="
allowed_out="$(docker run --rm --network "$NET" "$CURL_IMAGE" -sk -w '\n%{http_code}' \
    --connect-to "$ALLOWED_HOST:5001:caddy:5001" "https://$ALLOWED_HOST:5001/" 2>&1 || true)"
allowed_code="$(echo "$allowed_out" | tail -1)"
expect "served hostname completes the handshake" 200 "$allowed_code"

issuer="$(docker run --rm --network "$NET" "$CURL_IMAGE" -sk --connect-to "$ALLOWED_HOST:5001:caddy:5001" \
    -w '%{certs}' -o /dev/null "https://$ALLOWED_HOST:5001/" 2>/dev/null | grep -i "Issuer:" | head -1 || true)"
case "$issuer" in
*Pebble*) pass "issued by a real ACME CA, not Caddy's local_certs ($issuer)" ;;
*) fail "expected the leaf's issuer to name Pebble, got: $issuer" ;;
esac

echo "== real Caddy + real Pebble: the disallowed hostname =="
disallowed_out="$(docker run --rm --network "$NET" "$CURL_IMAGE" -sk -w '\n%{http_code}\n%{exitcode}' \
    --connect-to "$DISALLOWED_HOST:5001:caddy:5001" "https://$DISALLOWED_HOST:5001/" 2>&1 || true)"
disallowed_code="$(echo "$disallowed_out" | sed -n '2p')"
disallowed_exit="$(echo "$disallowed_out" | sed -n '3p')"
if [ "$disallowed_code" = "000" ] || [ -z "$disallowed_code" ]; then
    pass "disallowed hostname: no HTTP status at all -- the handshake itself failed (curl exit $disallowed_exit)"
else
    fail "disallowed hostname: expected no HTTP status (handshake failure), got HTTP $disallowed_code"
fi

echo "== Caddy's own log: an issuance attempt for the allowed host, none for the disallowed one =="
caddy_log="$(docker logs "$CADDY" 2>&1)"
if echo "$caddy_log" | grep -F "certificate obtained successfully" | grep -qF "\"identifier\":\"$ALLOWED_HOST\""; then
    pass "Caddy logged a successful obtain for the allowed host"
else
    fail "Caddy's log has no successful-obtain entry for $ALLOWED_HOST"
fi
if echo "$caddy_log" | grep -q "$DISALLOWED_HOST"; then
    fail "Caddy's log mentions the disallowed host at all -- the ask should have refused it before anything worth logging happened"
else
    pass "Caddy's log never mentions the disallowed host -- refused before any issuance attempt was logged"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "odask live proof: all checks passed"
    exit 0
else
    echo "odask live proof: $FAILURES check(s) failed"
    exit 1
fi
