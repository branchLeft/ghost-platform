#!/bin/sh
# Proves demo-host/provision/branchleft_demo_egress.sh against a real dockerd
# inside a privileged Docker-in-Docker stand-in for demo1; see that script's
# .md, "Proof". Creates only containers and a network under one prefix.
# Usage: ./scripts/test-demo-container-egress.sh
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="bl-demo-egress-proof-$$"
HOST="$PREFIX-host"
OUTSIDE="$PREFIX-outside"
NET="$PREFIX-net"
DIND_IMAGE="docker:27-dind"
PROBE_IMAGE="python:3.12-alpine"

PASSES=0
FAILURES=0

cleanup() {
    # -v: the dind image declares /var/lib/docker a volume, and each run
    # would otherwise leave an anonymous one behind holding the loaded images.
    docker rm -f -v "$HOST" "$OUTSIDE" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
[ -n "${KEEP_PROOF_CONTAINERS:-}" ] || trap cleanup EXIT INT TERM

pass() { PASSES=$((PASSES + 1)); echo "PASS: $*"; }
fail() { FAILURES=$((FAILURES + 1)); echo "FAIL: $*"; }

# Runs on the stand-in host with dockerd's own PATH: the dind image ships both
# iptables backends and gives dockerd whichever works, and the policy must
# write to the same one, as it does on the real host.
DOCKERD_PATH=""
on_host() {
    if [ -n "$DOCKERD_PATH" ]; then
        docker exec -e PATH="$DOCKERD_PATH" "$HOST" sh -c "$1"
    else
        docker exec "$HOST" sh -c "$1"
    fi
}

# A one-shot probe container on the stand-in host. Exit 0 means it connected.
probe() {
    network="$1"
    shift
    on_host "docker run --rm --network $network $PROBE_IMAGE $*" >/dev/null 2>&1
}

expect_reach() {
    if eval "$2"; then pass "$1"; else fail "$1"; fi
}

expect_blocked() {
    if eval "$2"; then fail "$1"; else pass "$1"; fi
}

docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1 || docker pull -q "$PROBE_IMAGE" >/dev/null
docker image inspect "$DIND_IMAGE" >/dev/null 2>&1 || docker pull -q "$DIND_IMAGE" >/dev/null

docker network create "$NET" >/dev/null
docker run -d --name "$OUTSIDE" --network "$NET" "$PROBE_IMAGE" \
    python -m http.server 8080 >/dev/null
OUTSIDE_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$OUTSIDE")"

docker run -d --privileged --name "$HOST" --hostname demo1 --network "$NET" \
    -e DOCKER_TLS_CERTDIR= \
    -v "$HERE/demo-host/provision:/policy:ro" \
    "$DIND_IMAGE" >/dev/null

tries=0
until on_host "docker info" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || { echo "the stand-in host's dockerd never came up"; exit 1; }
    sleep 1
done
# shellcheck disable=SC2016 # expanded on the stand-in host, not here
DOCKERD_PATH="$(on_host 'tr "\0" "\n" < /proc/$(pidof dockerd)/environ | sed -n "s/^PATH=//p"')"
[ -n "$DOCKERD_PATH" ] || { echo "could not read dockerd's PATH on the stand-in host"; exit 1; }

docker save "$PROBE_IMAGE" | docker exec -i "$HOST" docker load >/dev/null

on_host "docker network create demo >/dev/null"
on_host "docker run -d --name slot --network demo -p 127.0.0.1:18080:8080 $PROBE_IMAGE python -m http.server 8080 >/dev/null"
docker exec -d "$HOST" sh -c "while true; do echo ok | nc -l -p 9099 >/dev/null 2>&1; done"
GATEWAY="$(on_host "docker network inspect demo -f '{{(index .IPAM.Config 0).Gateway}}'")"

tries=0
until on_host "wget -q -T 2 -O /dev/null http://127.0.0.1:18080/" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 30 ] || { echo "the slot container never answered"; exit 1; }
    sleep 1
done

TO_OUTSIDE="wget -q -T 3 -O /dev/null http://$OUTSIDE_IP:8080/"
TO_HOST="sh -c 'echo | nc -w 3 $GATEWAY 9099 | grep -q ok'"

echo "== controls, before the policy"
expect_reach "a demo-network container reaches the outside" "probe demo \"$TO_OUTSIDE\""
expect_reach "a default-bridge container reaches the outside" "probe bridge \"$TO_OUTSIDE\""
expect_reach "a demo-network container reaches a host service" "probe demo \"$TO_HOST\""

echo "== the wrong host is refused"
if on_host "BRANCHLEFT_DEMO_EGRESS_HOST=app1 sh /policy/branchleft_demo_egress.sh" >/dev/null 2>&1; then
    fail "the policy ran on a host not named app1 while told to expect app1"
else
    pass "the policy refuses a host that is not the expected one"
fi
expect_reach "the refusal changed nothing" "probe demo \"$TO_OUTSIDE\""

echo "== the policy"
on_host "sh /policy/branchleft_demo_egress.sh"
FIRST="$(on_host "iptables-save; ip6tables-save" | grep -c BRANCHLEFT-DEMO)"
on_host "sh /policy/branchleft_demo_egress.sh" >/dev/null
SECOND="$(on_host "iptables-save; ip6tables-save" | grep -c BRANCHLEFT-DEMO)"
if [ "$FIRST" = "$SECOND" ]; then
    pass "a second run leaves the same $FIRST policy lines"
else
    fail "a second run changed the policy line count from $FIRST to $SECOND"
fi

echo "== after the policy"
expect_blocked "a demo-network container cannot reach the outside" "probe demo \"$TO_OUTSIDE\""
expect_blocked "a default-bridge container cannot reach the outside" "probe bridge \"$TO_OUTSIDE\""
expect_blocked "a demo-network container cannot reach a host service" "probe demo \"$TO_HOST\""
expect_reach "the host itself still reaches the outside" "on_host \"$TO_OUTSIDE\""
expect_reach "the host still reaches a slot on its published port" \
    "on_host \"wget -q -T 3 -O /dev/null http://127.0.0.1:18080/\""
expect_reach "a container still reaches another on its own network" \
    "probe demo \"wget -q -T 3 -O /dev/null http://slot:8080/\""
expect_reach "the IPv6 family carries the same rules (rule presence only; no IPv6 traffic is sent)" \
    "on_host \"ip6tables -S BRANCHLEFT-DEMO-EGRESS | grep -q -- '-i br-+ ! -o br-+ -j REJECT'\""

echo
echo "$PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
