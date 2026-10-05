#!/bin/sh
# Proves demo-host/provision/drain_flag_dir.py's permission shape against
# real uids in a real container, rather than mocked chown/chmod calls --
# test_drain_flag_dir.py covers the logic, this covers what the bits
# actually permit. Runs inside a throwaway container, never the host or the
# runner, because it creates system users and writes to a real filesystem
# path.
# See test-drain-flag-dir-permissions.md#what-this-proves.
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

    python3 /repo/drain_flag_dir.py --path /var/lib/branchleft-broker/drain-flags --broker-user broker

    echo "OWNER=$(stat -c "%U:%G" /var/lib/branchleft-broker/drain-flags)"
    echo "MODE=$(stat -c "%a" /var/lib/branchleft-broker/drain-flags)"
    echo "STATE_DIR=$(stat -c "%U:%G %a" /var/lib/branchleft-broker)"

    # A sidecar reaches the flag directory through a bind mount, so the
    # 0750 state directory above it is not on its way in. Widen it here so
    # the checks below test the flag directory'"'"'s own bits, not that parent.
    chmod 0755 /var/lib/branchleft-broker

    if su sidecar-uid -c "cat /var/lib/branchleft-broker/drain-flags/0-a.drain" >/dev/null 2>&1; then
      echo "SIDECAR_READ=ok"
    else
      echo "SIDECAR_READ=denied"
    fi

    if su sidecar-uid -c "touch /var/lib/branchleft-broker/drain-flags/sidecar-write-attempt" >/dev/null 2>&1; then
      echo "SIDECAR_WRITE=allowed"
    else
      echo "SIDECAR_WRITE=denied"
    fi

    if su slot-uid -c "touch /var/lib/branchleft-broker/drain-flags/slot-write-attempt" >/dev/null 2>&1; then
      echo "SLOT_WRITE=allowed"
    else
      echo "SLOT_WRITE=denied"
    fi

    if su broker -c "touch /var/lib/branchleft-broker/drain-flags/broker-write-attempt" >/dev/null 2>&1; then
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
check "STATE_DIR" "broker:broker 750"
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
