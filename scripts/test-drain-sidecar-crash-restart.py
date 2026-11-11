#!/usr/bin/env python3
"""Proves a drain-sidecar recovers when Docker restarts the Ghost it shares a
network namespace with.

Usage: test-drain-sidecar-crash-restart.py <sidecar-image> <platform-image>

Exit 0 when the sidecar with `EXIT_AFTER_GHOST_UNREACHABLE_MS` and
`--restart on-failure` answers 200 again after Ghost is killed and
restarted, and a control sidecar without them does not. Exit 1 otherwise.
See scripts/test-drain-sidecar-crash-restart.md.
"""

from __future__ import annotations

import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

GHOST_PORT = 4220
WATCHED_PORT = 4221
CONTROL_PORT = 4222
STALE_AFTER_MS = 4000
BOOT_SECONDS = 150
RECOVERY_SECONDS = 90

RUN_ID = uuid.uuid4().hex[:8]
GHOST_NAME = f"sidecar-restart-ghost-{RUN_ID}"
WATCHED_NAME = f"sidecar-restart-watched-{RUN_ID}"
CONTROL_NAME = f"sidecar-restart-control-{RUN_ID}"

GHOST_ENV = {
    "url": f"https://localhost:{GHOST_PORT}",
    "database__client": "sqlite3",
    "database__connection__filename": "/var/lib/ghost/content/data/ghost-restart-test.db",
    "privacy__useUpdateCheck": "false",
    "BRANCHLEFT_ALLOW_LOCAL_STORAGE": "true",
    "storage__images__adapter": "ScanningStorageAdapter",
    "storage__images__wraps": "LocalImagesStorage",
    "storage__images__quarantinePath": "/var/lib/ghost/content/quarantine",
    "storage__media__adapter": "ScanningStorageAdapter",
    "storage__media__wraps": "LocalMediaStorage",
    "storage__media__quarantinePath": "/var/lib/ghost/content/quarantine",
    "storage__files__adapter": "ScanningStorageAdapter",
    "storage__files__wraps": "LocalFilesStorage",
    "storage__files__quarantinePath": "/var/lib/ghost/content/quarantine",
}


def docker(*args: str, check: bool = True) -> str:
    result = subprocess.run(["docker", *args], capture_output=True, text=True, check=False)
    if check and result.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args[:2])} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def status(port: int) -> int:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/healthz", headers={"X-Forwarded-Proto": "https"}
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except OSError:
        return 0


def ghost_front_page_status() -> int:
    request = urllib.request.Request(
        f"http://127.0.0.1:{GHOST_PORT}/", headers={"X-Forwarded-Proto": "https"}
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except OSError:
        return 0


def wait_for(what: str, seconds: int, done) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if done():
            return
        time.sleep(1)
    raise RuntimeError(f"timed out after {seconds}s waiting for {what}")


def sidecar_args(name: str, port: int, *, watched: bool) -> list[str]:
    args = [
        "run", "-d", "--name", name, "--network", f"container:{GHOST_NAME}",
        "--restart", "on-failure" if watched else "no",
        "--mount", "type=tmpfs,destination=/var/run/branchleft",
        "-e", "DRAIN_FLAG_PATH=/var/run/branchleft/drain",
        "-e", "GHOST_HEALTH_URL=http://127.0.0.1:2368/",
        "-e", f"PORT={port}",
    ]  # fmt: skip
    if watched:
        args += ["-e", f"EXIT_AFTER_GHOST_UNREACHABLE_MS={STALE_AFTER_MS}"]
    return args


def sandbox_key(name: str) -> str:
    return docker("inspect", "--format", "{{.NetworkSettings.SandboxKey}}", name)


def restart_count(name: str) -> int:
    return int(docker("inspect", "--format", "{{.RestartCount}}", name))


def run() -> list[str]:
    failures: list[str] = []
    ghost_args = ["run", "-d", "--name", GHOST_NAME, "--restart", "on-failure"]
    for port in (GHOST_PORT, WATCHED_PORT, CONTROL_PORT):
        ghost_args += ["-p", f"{port}:{2368 if port == GHOST_PORT else port}"]
    for key, value in GHOST_ENV.items():
        ghost_args += ["-e", f"{key}={value}"]
    docker(*ghost_args, sys.argv[2])
    docker(*sidecar_args(WATCHED_NAME, WATCHED_PORT, watched=True), sys.argv[1])
    docker(*sidecar_args(CONTROL_NAME, CONTROL_PORT, watched=False), sys.argv[1])

    print("--- both sidecars answer 200 beside a booted Ghost ---")
    wait_for("both sidecars to answer 200", BOOT_SECONDS,
             lambda: status(WATCHED_PORT) == 200 and status(CONTROL_PORT) == 200)  # fmt: skip

    before = sandbox_key(GHOST_NAME)
    print("--- crashing Ghost; Docker restarts it into a new network namespace ---")
    # Killed from outside the container's own control, so Docker sees a crash.
    # `docker kill` counts as a manual stop and is not restarted.
    pid = docker("inspect", "--format", "{{.State.Pid}}", GHOST_NAME)
    subprocess.run(["sudo", "kill", "-9", pid], check=True)
    wait_for("Docker to restart Ghost", 60, lambda: restart_count(GHOST_NAME) >= 1)
    wait_for("Ghost to answer again", BOOT_SECONDS, lambda: ghost_front_page_status() == 200)
    if sandbox_key(GHOST_NAME) == before:
        failures.append("Ghost kept its network namespace, so the test proved nothing")

    print("--- the watched sidecar rejoins and answers 200 again ---")
    try:
        wait_for("the watched sidecar to answer 200", RECOVERY_SECONDS,
                 lambda: status(WATCHED_PORT) == 200)  # fmt: skip
    except RuntimeError as exc:
        failures.append(str(exc))
    if restart_count(WATCHED_NAME) < 1:
        failures.append("the watched sidecar was never restarted")

    print("--- the control, left in the dead namespace, still does not answer 200 ---")
    if status(CONTROL_PORT) == 200:
        failures.append("the control sidecar recovered without the fix, so the test cannot fail")
    return failures


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        failures = run()
    except RuntimeError as exc:
        failures = [str(exc)]
    finally:
        for name in (CONTROL_NAME, WATCHED_NAME, GHOST_NAME):
            docker("rm", "-f", name, check=False)
    for failure in failures:
        print(f"FAIL: {failure}")
    if not failures:
        print("PASS: the sidecar rejoined Ghost's new namespace; the control did not")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
