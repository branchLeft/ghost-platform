#!/bin/sh
# Denies every bridged container on the demo host any connection it opens
# itself; the host keeps its own egress. What it allows, and why it refuses
# to run elsewhere: branchleft_demo_egress.md.
set -eu

EXPECTED_HOST="${BRANCHLEFT_DEMO_EGRESS_HOST:-demo1}"
FORWARD_CHAIN="BRANCHLEFT-DEMO-EGRESS"
INPUT_CHAIN="BRANCHLEFT-DEMO-INPUT"
# docker0 is the default bridge; br-+ is every user-defined bridge network.
BRIDGES="docker0 br-+"

say() { echo "branchleft-demo-egress: $*"; }
die() {
    echo "branchleft-demo-egress: $*" >&2
    exit 1
}

this_host="$(hostname -s)"
[ "$this_host" = "$EXPECTED_HOST" ] ||
    die "this host is '$this_host', not '$EXPECTED_HOST' -- the demo container egress policy belongs on the demo host only"

ruleset() {
    printf '%s\n' '*filter' ":$FORWARD_CHAIN - [0:0]" ":$INPUT_CHAIN - [0:0]"
    echo "-A $FORWARD_CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
    for bridge in $BRIDGES; do
        echo "-A $FORWARD_CHAIN -i $bridge ! -o $bridge -j DROP"
    done
    echo "-A $INPUT_CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
    echo "-A $INPUT_CHAIN -j DROP"
    echo "COMMIT"
}

# Inserted first, because an accept ahead of the jump would outrank it.
ensure_jump() {
    tool="$1"
    chain="$2"
    shift 2
    if "$tool" -t filter -C "$chain" "$@" 2>/dev/null; then
        say "$tool $chain already carries: $*"
    else
        "$tool" -t filter -I "$chain" 1 "$@"
        say "$tool inserted into $chain: $*"
    fi
}

apply_family() {
    tool="$1"
    command -v "$tool" >/dev/null 2>&1 ||
        die "$tool is not installed -- Docker brings it; install Docker first"
    "$tool" -t filter -S DOCKER-USER >/dev/null 2>&1 ||
        die "no DOCKER-USER chain in $tool -- either Docker is not running yet or its nftables backend is active, and this policy has no safe substitute chain"

    ruleset | "$tool-restore" --noflush
    ensure_jump "$tool" DOCKER-USER -j "$FORWARD_CHAIN"
    for bridge in $BRIDGES; do
        ensure_jump "$tool" INPUT -i "$bridge" -j "$INPUT_CHAIN"
    done
}

apply_family iptables
apply_family ip6tables

say "demo container egress denied on $this_host"
