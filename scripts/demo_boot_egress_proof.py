#!/usr/bin/env python3
"""Proves the demo host's boot order against a real dockerd in a Docker-in-Docker stand-in.

A slot container with a restart policy starts with dockerd, so the egress policy must be in
force before dockerd starts. The slot tries the outside for ten seconds from its start and
records whether any try got through. "policy-after" applies the policy once dockerd is up, the
order the unit had before it was made Before=docker.service; it must record a success (the red
control). "policy-first" applies the policy before dockerd, as the unit now does; it must record
none (green). See demo-host/provision/branchleft_demo_egress.md, "Proof".

This needs a real systemd boot to prove the unit's own ordering, which the Docker-in-Docker
stand-in does not exercise: run it on a VM or on demo1, not on a developer machine.

Usage: python3 scripts/demo_boot_egress_proof.py
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence

HERE: pathlib.Path = pathlib.Path(__file__).resolve().parent.parent
PROVISION: pathlib.Path = HERE / "demo-host" / "provision"
DIND_IMAGE: str = "docker:27-dind"
PROBE_IMAGE: str = "python:3.12-alpine"
# Seconds one docker call may run before the proof stops, so a stalled engine fails fast.
CALL_TIMEOUT: int = 120
# Seconds the slot tries the outside after it starts.
SLOT_WINDOW: int = 10
WAIT_TRIES: int = 90


def docker(args: Sequence[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - argv list, no shell
        ["docker", *args],
        check=check,
        capture_output=True,
        text=True,
        timeout=CALL_TIMEOUT,
    )


def on_host(host: str, command: str) -> subprocess.CompletedProcess[str]:
    return docker(["exec", host, "sh", "-c", command])


def wait_for_dockerd(host: str) -> None:
    for _ in range(WAIT_TRIES):
        if on_host(host, "docker info").returncode == 0:
            return
        time.sleep(1)
    raise SystemExit(f"the stand-in host's dockerd never came up ({host})")


def start_host(host: str, network: str, lib: str, shared: pathlib.Path, policy_first: bool) -> None:
    common: list[str] = [
        "run", "-d", "--name", host, "--hostname", "demo1", "--privileged",
        "--network", network,
        "-e", "DOCKER_TLS_CERTDIR=",
        "-v", f"{lib}:/var/lib/docker",
        "-v", f"{shared}:/shared",
        "-v", f"{PROVISION}:/policy:ro",
    ]
    if policy_first:
        entry = (
            "apk add --no-cache python3 >/dev/null"
            " && python3 -I /policy/branchleft_demo_egress.py"
            " && exec dockerd-entrypoint.sh"
        )
        docker([*common, "--entrypoint", "sh", DIND_IMAGE, "-c", entry])
    else:
        docker([*common, DIND_IMAGE])
    wait_for_dockerd(host)


def slot_command(outside_ip: str) -> str:
    # Runs inside the slot: tries the outside for SLOT_WINDOW seconds, records whether any
    # try got through, then stays up so the restart policy is the only thing that starts it.
    return (
        f"end=$(( $(date +%s) + {SLOT_WINDOW} )); reached=no; "
        f"while [ $(date +%s) -lt $end ]; do "
        f"if wget -q -T 1 -O /dev/null http://{outside_ip}:8080/; then reached=yes; fi; "
        "sleep 0.2; done; "
        "echo $reached > /shared/slot-attempts; sleep 600"
    )


def slot_record(shared: pathlib.Path) -> str:
    record = shared / "slot-attempts"
    for _ in range(WAIT_TRIES + SLOT_WINDOW):
        if record.exists() and record.stat().st_size > 0:
            return record.read_text(encoding="utf-8").strip()
        time.sleep(1)
    raise SystemExit("the slot never recorded its attempt")


def stop_host(host: str) -> None:
    docker(["stop", host])
    docker(["rm", host])


def run_proof(prefix: str) -> tuple[str, str]:
    boot = f"{prefix}-host"
    outside = f"{prefix}-outside"
    network = f"{prefix}-net"
    lib = f"{prefix}-lib"
    with tempfile.TemporaryDirectory() as tmp:
        shared = pathlib.Path(tmp)
        docker(["network", "create", network])
        docker(["run", "-d", "--name", outside, "--network", network, PROBE_IMAGE,
                "python", "-m", "http.server", "8080"])
        outside_ip = docker([
            "inspect", "-f",
            '{{(index .NetworkSettings.Networks "' + network + '").IPAddress}}',
            outside,
        ]).stdout.strip()

        # First life, no policy: the slot is created, and its restart policy is recorded in the
        # host's state, which the second and third lives reuse.
        start_host(boot, network, lib, shared, policy_first=False)
        on_host(boot, "docker network create demo >/dev/null")
        on_host(
            boot,
            f"docker run -d --name slot --restart unless-stopped --network demo "
            f"-v /shared:/shared {PROBE_IMAGE} sh -c '{slot_command(outside_ip)}' >/dev/null",
        )
        slot_record(shared)
        stop_host(boot)

        # Second life: dockerd first, the policy after it (the control).
        (shared / "slot-attempts").unlink(missing_ok=True)
        start_host(boot, network, lib, shared, policy_first=False)
        on_host(boot, "apk add --no-cache python3 >/dev/null && python3 -I /policy/branchleft_demo_egress.py >/dev/null")
        after = slot_record(shared)
        stop_host(boot)

        # Third life: the policy first, then dockerd.
        (shared / "slot-attempts").unlink(missing_ok=True)
        start_host(boot, network, lib, shared, policy_first=True)
        first = slot_record(shared)
        stop_host(boot)
    return after, first


def cleanup(prefix: str) -> None:
    boot = f"{prefix}-host"
    outside = f"{prefix}-outside"
    docker(["rm", "-f", "-v", boot, outside], check=False)
    docker(["volume", "rm", f"{prefix}-lib"], check=False)
    docker(["network", "rm", f"{prefix}-net"], check=False)


def main() -> int:
    prefix = f"bl-demo-boot-proof-{os.getpid()}"
    for image in (PROBE_IMAGE, DIND_IMAGE):
        if docker(["image", "inspect", image], check=False).returncode != 0:
            docker(["pull", "-q", image])
    try:
        after, first = run_proof(prefix)
    finally:
        cleanup(prefix)
    print(f"policy-after: the slot reached the outside during its window: {after}")
    print(f"policy-first: the slot reached the outside during its window: {first}")
    if after == "yes" and first == "no":
        print("PASS: the window exists when the policy follows dockerd, and is closed when it precedes it")
        return 0
    print("FAIL: expected policy-after yes and policy-first no")
    return 1


if __name__ == "__main__":
    sys.exit(main())
