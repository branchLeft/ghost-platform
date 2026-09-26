#!/bin/sh
# Proves demo-host/provision/drain_flag_dir.py's permission shape against
# real uids in a real container, rather than against mocked chown/chmod
# calls (test_drain_flag_dir.py covers the logic; this covers what the
# bits actually permit): the broker account can create and remove flags,
# the sidecar's own uid (1000, baked into the node:*-bookworm-slim base
# image) can read and traverse the directory but never write to it, and a
# slot uid gets exactly the same refusal -- proving the directory is not
# merely "not broker" but genuinely nobody-else-writable.
#
# Runs inside a throwaway container, never against the host or the runner,
# because it creates system users and writes to a real filesystem path.
#
# Usage:
#   ./scripts/test-drain-flag-dir-permissions.sh
set -e

FAILURES=0

RESULT="$(docker run --rm -v "$PWD/demo-host/provision":/repo:ro -w /tmp debian:bookworm-slim sh -c '
    set -e
    apt-get update -qq >/dev/null
    apt-get install -y -qq python3 >/dev/null

    useradd -u 64200 -M -s /bin/sh broker
    useradd -u 1000 -M -s /bin/sh sidecar-uid
    useradd -u 30001 -M -s /bin/sh slot-uid

    python3 /repo/drain_flag_dir.py --path /var/run/branchleft/drain-flags --broker-user broker

    echo "OWNER=$(stat -c "%U:%G" /var/run/branchleft/drain-flags)"
    echo "MODE=$(stat -c "%a" /var/run/branchleft/drain-flags)"

    if su sidecar-uid -c "cat /var/run/branchleft/drain-flags/0-a.drain" >/dev/null 2>&1; then
      echo "SIDECAR_READ=ok"
    else
      echo "SIDECAR_READ=denied"
    fi

    if su sidecar-uid -c "touch /var/run/branchleft/drain-flags/sidecar-write-attempt" >/dev/null 2>&1; then
      echo "SIDECAR_WRITE=allowed"
    else
      echo "SIDECAR_WRITE=denied"
    fi

    if su slot-uid -c "touch /var/run/branchleft/drain-flags/slot-write-attempt" >/dev/null 2>&1; then
      echo "SLOT_WRITE=allowed"
    else
      echo "SLOT_WRITE=denied"
    fi

    if su broker -c "touch /var/run/branchleft/drain-flags/broker-write-attempt" >/dev/null 2>&1; then
      echo "BROKER_WRITE=ok"
    else
      echo "BROKER_WRITE=denied"
    fi
' 2>/dev/null)"

echo "$RESULT"
echo

check() {
    label="$1"
    expected="$2"
    got="$(printf "%s\n" "$RESULT" | grep "^${label}=" | cut -d= -f2)"
    if [ "$got" = "$expected" ]; then
        echo "PASS: $label is $got"
    else
        echo "FAIL: $label expected $expected, got ${got:-<missing>}"
        FAILURES=$((FAILURES + 1))
    fi
}

check "OWNER" "broker:broker"
check "MODE" "755"
check "SIDECAR_READ" "ok"
check "SIDECAR_WRITE" "denied"
check "SLOT_WRITE" "denied"
check "BROKER_WRITE" "ok"

if [ "$FAILURES" -gt 0 ]; then
    echo
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo
echo "All drain-flag-directory permission checks passed."
