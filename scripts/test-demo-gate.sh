#!/bin/sh
# Proves the demo gate's contract live: a real Caddy with forward_auth in
# front of a stand-in slot, the gate image under test beside it, and
# visitors arriving from distinct addresses on a Docker network -- the
# placement ghost-platform-docs/19-try-it-now-design/05-gate-and-edge.html
# §03 draws.
#
# What it shows, each against the real edge rather than the service alone:
#   - no cookie is refused on every path, /ghost/ and /ghost/api/admin/ included
#   - a wrong passphrase is refused and sets no cookie
#   - the right passphrase sets a HttpOnly, Secure, SameSite=Lax, host-only
#     cookie, and that cookie reaches the slot
#   - the cookie does not open the other slot's host
#   - a tampered cookie and an expired cookie are refused, beside a control
#     cookie forged the same way that is admitted -- so the refusals are the
#     gate's verdict, not a forging mistake
#   - recycling the slot (a new lease record) kills the cookie at once
#   - the per-source ceiling trips for one visitor while another still gets
#     in, and neither a spoofed X-Forwarded-For through the edge nor one sent
#     straight to the gate resets it
#   - a corrupt slots file and a stopped gate both deny, never admit
#
# Usage:
#   docker build -f services/demo-gate/Dockerfile --secret id=node_auth_token,env=NODE_AUTH_TOKEN -t demo-gate:local .
#   ./scripts/test-demo-gate.sh demo-gate:local
set -eu

GATE_IMAGE="${1:?usage: test-demo-gate.sh <gate-image-tag>}"
CADDY_IMAGE="caddy:2.11.4-alpine"
CURL_IMAGE="curlimages/curl:8.16.0"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="$$"
NET="demo-gate-proof-$RUN_ID"
SUBNET="10.231.77.0/24"
CADDY_IP="10.231.77.2"
GATE_IP="10.231.77.3"
SLOT_IP="10.231.77.4"
VISITOR_A="10.231.77.10"
VISITOR_B="10.231.77.11"
HOST_A="slot0.demo.test"
HOST_B="slot1.demo.test"
PASS_A="proof-passphrase-slot-0"
PASS_B="proof-passphrase-slot-1"
LEASE_1="01J9F4Q7ZC3M8V2K6X0R5T1B9D"
LEASE_2="01J9F4Q7ZC3M8V2K6X0R5T1B9E"
LEASE_B="01J9F4Q7ZC3M8V2K6X0R5T1B9F"
CEILING=5
CADDY="demo-gate-proof-caddy-$RUN_ID"
GATE="demo-gate-proof-gate-$RUN_ID"
SLOT="demo-gate-proof-slot-$RUN_ID"

WORK="$(mktemp -d)"
# The gate runs as uid 1000; these are throwaway test fixtures, so they are
# made readable to it rather than chowned. A real host gives the key to the
# gate's own uid, mode 0400.
chmod 0755 "$WORK"
mkdir -m 0755 "$WORK/config" "$WORK/leases"
FAILURES=0

cleanup() {
    docker rm -f "$CADDY" "$GATE" "$SLOT" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }
expect() {
    if [ "$3" = "$2" ]; then pass "$1 ($3)"; else fail "$1: expected $2, got $3"; fi
}

# One request from a visitor at a fixed address. Every request goes through
# Caddy on 443 unless the caller points it elsewhere.
visit() {
    ip="$1"
    shift
    docker run --rm --network "$NET" --ip "$ip" "$CURL_IMAGE" -sk \
        --resolve "$HOST_A:443:$CADDY_IP" --resolve "$HOST_B:443:$CADDY_IP" "$@"
}
status() {
    ip="$1"
    shift
    visit "$ip" -o /dev/null -w '%{http_code}' "$@"
}
login() {
    # login <visitor-ip> <host> <passphrase> [extra curl args] -> response headers
    ip="$1"; host="$2"; pass="$3"
    shift 3
    visit "$ip" -o /dev/null -D - --data-urlencode "passphrase=$pass" --data-urlencode "r=/ghost/" \
        "$@" "https://$host/__gate/login" | tr -d '\r'
}
code_of() { sed -n '1s/^HTTP[^ ]* \([0-9]*\).*/\1/p'; }
cookie_of() { sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\);.*/\1/p'; }
forge() {
    # forge <slot> <lease> <exp> -> a cookie signed with the gate's real key
    docker run --rm -v "$WORK/config:/etc/demo-gate:ro" "$GATE_IMAGE" node -e '
      const { createHmac } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      const [slot, lease, exp] = process.argv.slice(1);
      const payload = `v1.${slot}.${lease}.${exp}`;
      const mac = createHmac("sha256", readFileSync("/etc/demo-gate/key")).update(payload).digest("base64url");
      process.stdout.write(`__Host-bl_demo_gate=${payload}.${mac}`);
    ' "$1" "$2" "$3"
}
write_lease() {
    # Written beside the record and renamed over it, as the broker must: a
    # reader never sees a half-written record.
    printf '{"slot":"%s","lease":"%s"}' "$1" "$2" > "$WORK/leases/.$1.tmp"
    chmod 0644 "$WORK/leases/.$1.tmp"
    mv "$WORK/leases/.$1.tmp" "$WORK/leases/$1.json"
}

echo "Gate image under test: $GATE_IMAGE"
echo "--- fixtures ---"
head -c 32 /dev/urandom > "$WORK/config/key"
chmod 0644 "$WORK/config/key"
HASH_A="$(printf %s "$PASS_A" | docker run --rm -i "$GATE_IMAGE" node dist/hashCli.js)"
HASH_B="$(printf %s "$PASS_B" | docker run --rm -i "$GATE_IMAGE" node dist/hashCli.js)"
cat > "$WORK/config/slots.json" <<EOF
{"slots":[
  {"host":"$HOST_A","slot":"0","gate":{"kind":"passphrase","argon2idHash":"$HASH_A"}},
  {"host":"$HOST_B","slot":"1","gate":{"kind":"passphrase","argon2idHash":"$HASH_B"}}
]}
EOF
chmod 0644 "$WORK/config/slots.json"
write_lease 0 "$LEASE_1"
write_lease 1 "$LEASE_B"
echo "  two gated hosts, argon2id hashes minted by the image's own hashCli"

echo "--- starting the stand-in slot, the gate and Caddy ---"
docker network create --subnet "$SUBNET" "$NET" >/dev/null
docker run -d --name "$SLOT" --network "$NET" --ip "$SLOT_IP" "$CADDY_IMAGE" \
    caddy respond --listen :8080 --body slot-upstream-ok >/dev/null
docker run -d --name "$GATE" --network "$NET" --ip "$GATE_IP" \
    -v "$WORK/config:/etc/demo-gate:ro" -v "$WORK/leases:/run/demo-leases:ro" \
    -e GATE_SIGNING_KEY_FILE=/etc/demo-gate/key \
    -e GATE_SLOTS_FILE=/etc/demo-gate/slots.json \
    -e GATE_LEASE_DIR=/run/demo-leases \
    -e GATE_TRUSTED_PROXIES="$CADDY_IP" \
    -e GATE_CEILING_ATTEMPTS="$CEILING" \
    -e GATE_COOKIE_TTL_SECONDS=3600 \
    "$GATE_IMAGE" >/dev/null
docker run -d --name "$CADDY" --network "$NET" --ip "$CADDY_IP" \
    -v "$HERE/services/demo-gate/proof/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -e DEMO_HOST_A="$HOST_A" -e DEMO_HOST_B="$HOST_B" \
    -e GATE_UPSTREAM="$GATE_IP:8080" -e SLOT_UPSTREAM="$SLOT_IP:8080" \
    "$CADDY_IMAGE" >/dev/null

for _ in $(seq 1 30); do
    if [ "$(status "$VISITOR_A" "https://$HOST_A/")" = "401" ]; then break; fi
    sleep 1
done

echo "--- 1. no cookie: refused on every path ---"
for path in / /ghost/ /ghost/api/admin/ /ghost/api/admin/settings/ /rss/ /sitemap.xml /robots.txt /members/api/member/; do
    expect "GET $path with no cookie" 401 "$(status "$VISITOR_A" "https://$HOST_A$path")"
done
expect "POST /ghost/api/admin/session with no cookie" 401 \
    "$(status "$VISITOR_A" -X POST "https://$HOST_A/ghost/api/admin/session")"
if visit "$VISITOR_A" "https://$HOST_A/ghost/" | grep -q slot-upstream-ok; then
    fail "the slot's body leaked through with no cookie"
else
    pass "the slot's body never reaches a visitor with no cookie"
fi
expect "X-Robots-Tag on the refusal" "noindex, nofollow" \
    "$(visit "$VISITOR_A" -o /dev/null -D - "https://$HOST_A/" | tr -d '\r' | sed -n 's/^[Xx]-[Rr]obots-[Tt]ag: //p' | head -1)"

echo "--- 2. wrong passphrase ---"
WRONG="$(login "$VISITOR_B" "$HOST_A" wrong-passphrase)"
expect "wrong passphrase" 401 "$(echo "$WRONG" | code_of)"
expect "cookies set on a wrong passphrase" "" "$(echo "$WRONG" | cookie_of)"

echo "--- 3. right passphrase ---"
RIGHT="$(login "$VISITOR_B" "$HOST_A" "$PASS_A")"
expect "right passphrase" 303 "$(echo "$RIGHT" | code_of)"
SETCOOKIE="$(echo "$RIGHT" | grep -i '^set-cookie:')"
echo "  $SETCOOKIE" | sed 's/=v1\.[^;]*/=<redacted>/'
for attr in HttpOnly Secure SameSite=Lax Path=/; do
    case "$SETCOOKIE" in *"; $attr"*) pass "cookie carries $attr" ;; *) fail "cookie lacks $attr" ;; esac
done
case "$SETCOOKIE" in *[Dd]omain=*) fail "cookie carries a Domain attribute" ;; *) pass "cookie is host-only (no Domain)" ;; esac
COOKIE="$(echo "$RIGHT" | cookie_of)"
case "$COOKIE" in *".0.$LEASE_1."*) pass "cookie names slot 0 and its current lease" ;; *) fail "cookie does not name slot 0's lease" ;; esac
expect "GET / with the cookie" 200 "$(status "$VISITOR_B" -H "Cookie: $COOKIE" "https://$HOST_A/")"
expect "GET /ghost/api/admin/ with the cookie" 200 \
    "$(status "$VISITOR_B" -H "Cookie: $COOKIE" "https://$HOST_A/ghost/api/admin/")"
expect "slot body behind the gate" slot-upstream-ok \
    "$(visit "$VISITOR_B" -H "Cookie: $COOKIE" "https://$HOST_A/")"

echo "--- 4. the cookie does not open another slot ---"
expect "slot 0's cookie on slot 1's host" 401 \
    "$(status "$VISITOR_B" -H "Cookie: $COOKIE" "https://$HOST_B/")"

echo "--- 5. tampered and expired cookies, beside a forged control ---"
NOW="$(date +%s)"
CONTROL="$(forge 0 "$LEASE_1" $((NOW + 600)))"
expect "control: a cookie forged with the real key and a live expiry" 200 \
    "$(status "$VISITOR_B" -H "Cookie: $CONTROL" "https://$HOST_A/")"
EXPIRED="$(forge 0 "$LEASE_1" $((NOW - 1)))"
expect "an expired cookie" 401 "$(status "$VISITOR_B" -H "Cookie: $EXPIRED" "https://$HOST_A/")"
TAMPERED="$(echo "$CONTROL" | sed "s/\.$((NOW + 600))\./.$((NOW + 999999))./")"
expect "a cookie with its expiry extended" 401 "$(status "$VISITOR_B" -H "Cookie: $TAMPERED" "https://$HOST_A/")"
TAMPERED_SLOT="$(echo "$COOKIE" | sed 's/=v1\.0\./=v1.1./')"
expect "a cookie re-pointed at slot 1" 401 \
    "$(status "$VISITOR_B" -H "Cookie: $TAMPERED_SLOT" "https://$HOST_B/")"

echo "--- 6. recycle: a new lease kills every earlier cookie ---"
write_lease 0 "$LEASE_2"
expect "the old cookie after the slot's lease changed" 401 \
    "$(status "$VISITOR_B" -H "Cookie: $COOKIE" "https://$HOST_A/")"
expect "the forged control after the slot's lease changed" 401 \
    "$(status "$VISITOR_B" -H "Cookie: $CONTROL" "https://$HOST_A/")"
RELOGIN="$(login "$VISITOR_B" "$HOST_A" "$PASS_A")"
NEWCOOKIE="$(echo "$RELOGIN" | cookie_of)"
case "$NEWCOOKIE" in *".0.$LEASE_2."*) pass "a fresh login binds to the new lease" ;; *) fail "fresh login not bound to the new lease" ;; esac
expect "the new cookie" 200 "$(status "$VISITOR_B" -H "Cookie: $NEWCOOKIE" "https://$HOST_A/")"
rm "$WORK/leases/0.json"
expect "a live cookie once the slot has no lease record at all" 401 \
    "$(status "$VISITOR_B" -H "Cookie: $NEWCOOKIE" "https://$HOST_A/")"
write_lease 0 "$LEASE_2"

echo "--- 7. per-source ceiling ($CEILING attempts) ---"
i=0
while [ "$i" -lt "$CEILING" ]; do
    i=$((i + 1))
    expect "visitor A wrong guess $i" 401 "$(login "$VISITOR_A" "$HOST_B" "guess-$i" | code_of)"
done
OVER="$(login "$VISITOR_A" "$HOST_B" "$PASS_B")"
expect "visitor A past the ceiling, even with the right passphrase" 429 "$(echo "$OVER" | code_of)"
expect "cookies set past the ceiling" "" "$(echo "$OVER" | cookie_of)"
expect "visitor A with a spoofed X-Forwarded-For through the edge" 429 \
    "$(login "$VISITOR_A" "$HOST_B" "$PASS_B" -H "X-Forwarded-For: 198.51.100.77" | code_of)"
DIRECT="$(docker run --rm --network "$NET" --ip "$VISITOR_A" "$CURL_IMAGE" -s -o /dev/null -w '%{http_code}' \
    -H "Host: $HOST_B" -H "X-Forwarded-For: 198.51.100.78" \
    --data-urlencode "passphrase=$PASS_B" "http://$GATE_IP:8080/__gate/login")"
expect "visitor A straight to the gate with a spoofed X-Forwarded-For" 429 "$DIRECT"
expect "visitor B, another source, still gets through" 303 \
    "$(login "$VISITOR_B" "$HOST_B" "$PASS_B" | code_of)"

echo "--- 8. failures deny ---"
cp "$WORK/config/slots.json" "$WORK/slots.good"
printf '{' > "$WORK/config/slots.json"
expect "a live cookie while the slots file is corrupt" 500 \
    "$(status "$VISITOR_B" -H "Cookie: $NEWCOOKIE" "https://$HOST_A/")"
cp "$WORK/slots.good" "$WORK/config/slots.json"
expect "the same cookie once the slots file is restored" 200 \
    "$(status "$VISITOR_B" -H "Cookie: $NEWCOOKIE" "https://$HOST_A/")"
docker stop -t 1 "$GATE" >/dev/null
STOPPED="$(status "$VISITOR_B" -H "Cookie: $NEWCOOKIE" "https://$HOST_A/")"
case "$STOPPED" in 2??) fail "a request was admitted with the gate stopped ($STOPPED)" ;; *) pass "gate stopped: the edge denies ($STOPPED)" ;; esac

echo
if [ "$FAILURES" -ne 0 ]; then
    echo "FAILED: $FAILURES check(s)"
    echo "--- gate logs ---"
    docker logs "$GATE" 2>&1 | tail -20
    exit 1
fi
echo "All checks passed."
