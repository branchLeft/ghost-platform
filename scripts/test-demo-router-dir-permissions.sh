#!/bin/sh
# Proves, against real uids in a real container, that the broker's account
# cannot rename the health router's directory once provision_socket_dirs.py
# has run: the state root is root-owned, and the broker owns only its own
# subdirectory. test_state_dirs.py models the same ownership; this runs it.
# Runs inside a throwaway container, never the host or the runner, because it
# creates system users and writes to a real filesystem path.
#
# Usage:
#   ./scripts/test-demo-router-dir-permissions.sh
set -e

FAILURES=0

RESULT="$(docker run --rm -v "$PWD/demo-host/provision":/repo:ro -w /tmp debian:bookworm-slim sh -c '
    set -e
    apt-get update -qq >/dev/null
    apt-get install -y -qq python3 >/dev/null

    useradd -u 64200 -M -s /bin/sh broker
    useradd -u 30008 -M -s /bin/sh demo-router

    python3 /repo/provision_socket_dirs.py >/dev/null

    echo "STATE_ROOT=$(stat -c "%U:%G %a" /var/lib/branchleft)"
    echo "ROUTER_ROOT=$(stat -c "%U:%G %a" /var/lib/branchleft/demo-router)"
    echo "BROKER_SLOTS=$(stat -c "%U:%G %a" /var/lib/branchleft/broker-slots)"

    if su broker -c "mv /var/lib/branchleft/demo-router /var/lib/branchleft/demo-router.moved" >/dev/null 2>&1; then
      echo "BROKER_RENAME_ROUTER=allowed"
    else
      echo "BROKER_RENAME_ROUTER=denied"
    fi

    if su broker -c "mkdir /var/lib/branchleft/demo-router-fake" >/dev/null 2>&1; then
      echo "BROKER_CREATE_IN_STATE_ROOT=allowed"
    else
      echo "BROKER_CREATE_IN_STATE_ROOT=denied"
    fi

    if su broker -c "mv /var/lib/branchleft/broker-slots /var/lib/branchleft/broker-slots.moved" >/dev/null 2>&1; then
      echo "BROKER_RENAME_OWN_DIR=allowed"
    else
      echo "BROKER_RENAME_OWN_DIR=denied"
    fi

    if su broker -c "echo {} > /var/lib/branchleft/broker-slots/slots.json" >/dev/null 2>&1; then
      echo "BROKER_WRITE_SLOTS_FILE=ok"
    else
      echo "BROKER_WRITE_SLOTS_FILE=denied"
    fi

    cd /repo && python3 -m unittest test_state_dirs >/dev/null 2>&1 && echo "REAL_UID_UNITTEST=ok" || echo "REAL_UID_UNITTEST=failed"
' 2>/dev/null)"

echo "$RESULT"
echo

check() {
    label="$1"
    expected="$2"
    got="$(printf "%s\n" "$RESULT" | grep "^${label}=" | cut -d= -f2-)"
    if [ "$got" = "$expected" ]; then
        echo "PASS: $label is $got"
    else
        echo "FAIL: $label expected $expected, got ${got:-<missing>}"
        FAILURES=$((FAILURES + 1))
    fi
}

check "STATE_ROOT" "root:root 755"
check "ROUTER_ROOT" "root:root 755"
check "BROKER_SLOTS" "broker:broker 755"
check "BROKER_RENAME_ROUTER" "denied"
check "BROKER_CREATE_IN_STATE_ROOT" "denied"
check "BROKER_RENAME_OWN_DIR" "denied"
check "BROKER_WRITE_SLOTS_FILE" "ok"
check "REAL_UID_UNITTEST" "ok"

if [ "$FAILURES" -gt 0 ]; then
    echo
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo
echo "All checks passed."
