#!/usr/bin/env bash
# The replica tunnel's control cases as runnable probes. Every probe prints
# PASS or FAIL, and the script exits non-zero if any probe fails.
# See probe_tunnel_controls.md for what each probe proves and where it runs.
set -uo pipefail

ACCOUNT="${PROBE_ACCOUNT:-dbtunnel}"
ALLOWED_LISTEN_PORT="${PROBE_ALLOWED_LISTEN_PORT:-13306}"
ALLOWED_OPEN_PORT="${PROBE_ALLOWED_OPEN_PORT:-9104}"
LOCAL_PROBE_PORT="${PROBE_LOCAL_PORT:-23306}"
TIMEOUT="${PROBE_TIMEOUT:-20}"
DIAL_TIMEOUT="${PROBE_DIAL_TIMEOUT:-10}"
SHELL_MARKER="tunnel-probe-shell-opened"

failures=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; failures=$((failures + 1)); }

usage() {
    echo "usage: $0 key-holder --host <ip> --key <path> --known-hosts <path>" >&2
    echo "       $0 direct-dial --control <host:port> --target <host:port> [--target <host:port> ...]" >&2
    exit 2
}

ssh_options() {
    SSH_OPTS=(-F none -i "$KEY" -o IdentitiesOnly=yes -o IdentityAgent=none
        -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS"
        -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ControlMaster=no
        -o ControlPath=none)
}

tunnel_ssh() {
    timeout "$TIMEOUT" ssh "${SSH_OPTS[@]}" "$@"
}

probe_no_shell() {
    local out
    out="$(tunnel_ssh -T "$ACCOUNT@$HOST" "echo $SHELL_MARKER" 2>&1)"
    if [[ "$out" == *"$SHELL_MARKER"* ]]; then
        fail "no-shell: the key ran a command on $HOST"
    elif [[ "$out" == *"account is currently not available"* ]]; then
        pass "no-shell: authenticated, and the command was refused by nologin"
    else
        fail "no-shell: inconclusive, the key did not authenticate: ${out//$'\n'/ | }"
    fi
}

probe_listen_refused() {
    local spec="$1" out rc=0
    out="$(tunnel_ssh -N -o ExitOnForwardFailure=yes -R "$spec:127.0.0.1:9" "$ACCOUNT@$HOST" 2>&1)" || rc=$?
    if [[ "$rc" -eq 0 || "$rc" -eq 124 ]]; then
        fail "listen-elsewhere: -R $spec was accepted and held open"
    elif [[ "$out" == *"remote port forwarding failed"* ]]; then
        pass "listen-elsewhere: -R $spec refused by $HOST"
    else
        fail "listen-elsewhere: -R $spec inconclusive: ${out//$'\n'/ | }"
    fi
}

# Opens one -L forward, connects through it once, and prints what came back.
open_through_forward() {
    local target="$1" log="$2" pid reply
    ssh "${SSH_OPTS[@]}" -N -o ExitOnForwardFailure=yes \
        -L "127.0.0.1:$LOCAL_PROBE_PORT:$target" "$ACCOUNT@$HOST" 2>"$log" &
    pid=$!
    sleep 3
    reply="$(timeout 8 bash -c "exec 3<>/dev/tcp/127.0.0.1/$LOCAL_PROBE_PORT \
        && IFS= read -r -t 5 line <&3; printf '%s' \"\${line:-}\"" 2>/dev/null)"
    sleep 1
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    printf '%s' "$reply"
}

probe_open_refused() {
    local target="127.0.0.1:22" log reply
    log="$(mktemp)"
    reply="$(open_through_forward "$target" "$log")"
    if [[ "$reply" == SSH-* ]]; then
        fail "open-elsewhere: -L to $target on $HOST answered ($reply)"
    elif grep -q "administratively prohibited" "$log"; then
        pass "open-elsewhere: -L to $target refused by $HOST"
    else
        fail "open-elsewhere: inconclusive: $(tr '\n' ' ' <"$log")"
    fi
    rm -f "$log"
}

probe_open_allowed() {
    local target="127.0.0.1:$ALLOWED_OPEN_PORT" log
    log="$(mktemp)"
    open_through_forward "$target" "$log" >/dev/null
    if grep -q "administratively prohibited" "$log"; then
        fail "open-allowed: -L to $target was refused, so open-elsewhere proves nothing"
    else
        pass "open-allowed: -L to $target is permitted (control for open-elsewhere)"
    fi
    rm -f "$log"
}

valid_host_port() {
    local LC_ALL=C spec="$1" port
    [[ "$spec" =~ ^[A-Za-z0-9._-]+:[0-9]+$ ]] || return 1
    port="${spec##*:}"
    port="${port#"${port%%[!0]*}"}"
    [[ -n "$port" && ${#port} -le 5 ]] && (( port >= 1 && port <= 65535 ))
}

validate_dial_timeout() {
    if [[ "$DIAL_TIMEOUT" =~ ^[0-9]+(\.[0-9]+)?$ && "$DIAL_TIMEOUT" =~ [1-9] ]]; then
        return 0
    fi
    printf 'PROBE_DIAL_TIMEOUT must be a positive number of seconds, such as 2 or 0.5: %q\n' "$DIAL_TIMEOUT" >&2
    exit 2
}

# Host and port go to bash as positional arguments, never into the dial string.
dial_succeeds() {
    local host="${1%:*}" port="${1##*:}"
    timeout "$DIAL_TIMEOUT" bash -c "exec 3<>/dev/tcp/\$1/\$2" _ "$host" "$port" 2>/dev/null
}

probe_direct_dial_control() {
    local control="$1"
    if dial_succeeds "$control"; then
        pass "direct-dial control: $control accepted a connection"
        return 0
    fi
    fail "direct-dial control: $control did not accept a connection, so no target result can be trusted"
    return 1
}

probe_direct_dial() {
    local target="$1"
    if dial_succeeds "$target"; then
        fail "direct-dial: a connection to $target was accepted"
    else
        pass "direct-dial: a connection to $target was not accepted"
    fi
}

run_key_holder() {
    HOST="" KEY="" KNOWN_HOSTS=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --host) HOST="$2"; shift 2 ;;
            --key) KEY="$2"; shift 2 ;;
            --known-hosts) KNOWN_HOSTS="$2"; shift 2 ;;
            *) usage ;;
        esac
    done
    [[ -n "$HOST" && -n "$KEY" && -n "$KNOWN_HOSTS" ]] || usage
    ssh_options
    probe_no_shell
    probe_listen_refused "127.0.0.1:$((ALLOWED_LISTEN_PORT + 1))"
    probe_listen_refused "0.0.0.0:$((ALLOWED_LISTEN_PORT + 2))"
    probe_open_refused
    probe_open_allowed
}

probe_direct_dial_targets() {
    local control="$1" target
    shift
    if probe_direct_dial_control "$control"; then
        for target in "$@"; do
            probe_direct_dial "$target"
        done
    else
        for target in "$@"; do
            fail "direct-dial: $target inconclusive, the control did not connect"
        done
    fi
}

run_direct_dial() {
    local control="" control_count=0 targets=() target
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --control)
                [[ $# -ge 2 ]] || usage
                control="$2"
                control_count=$((control_count + 1))
                shift 2
                ;;
            --target)
                [[ $# -ge 2 ]] || usage
                targets+=("$2")
                shift 2
                ;;
            *) usage ;;
        esac
    done
    [[ "$control_count" -eq 1 && ${#targets[@]} -gt 0 ]] || usage
    valid_host_port "$control" || usage
    for target in "${targets[@]}"; do
        valid_host_port "$target" || usage
    done
    validate_dial_timeout
    probe_direct_dial_targets "$control" "${targets[@]}"
}

[[ $# -ge 1 ]] || usage
mode="$1"
shift
case "$mode" in
    key-holder) run_key_holder "$@" ;;
    direct-dial) run_direct_dial "$@" ;;
    *) usage ;;
esac

if [[ "$failures" -gt 0 ]]; then
    echo "RED: $failures probe(s) failed"
    exit 1
fi
echo "GREEN: every probe passed"
