#!/usr/bin/python3 -I
"""Smoke check for the derived Percona image.

Starts one throwaway container of the image named on the command line, waits
until the server accepts connections on its port, and checks that it is still
Percona Server 8.0.46-37, that telemetry is off, that the telemetry agent and
MySQL Shell are gone, and that none of the libraries the scan reports against
this image is loaded into the running server. The container is always removed.
What each check proves, and what it does not, is in README.md.
"""

from __future__ import annotations

import re
import subprocess
import sys
import time
import uuid

EXPECTED_VERSION = "8.0.46-37"
REMOVED_PACKAGES = ("percona-telemetry-agent", "percona-mysql-shell")
# Libraries behind the findings the image carries an exemption for.
UNLOADED_LIBRARIES = (
    "krb5",
    "gssapi",
    "sqlite",
    "expat",
    "libmount",
    "libblkid",
    "libuuid",
    "json-glib",
)
READY_TIMEOUT_SECONDS = 180

# The first-start initialisation runs a temporary server that listens on no
# port; only the real server announces port 3306.
READY_LINE = re.compile(r"ready for connections\..*port: 3306\b")


def ready(log_text: str) -> bool:
    return READY_LINE.search(log_text) is not None


def variable_value(output: str, name: str) -> str | None:
    """The value in `SHOW VARIABLES LIKE name` output taken as tab-separated rows."""
    for line in output.splitlines():
        key, _, value = line.partition("\t")
        if key == name:
            return value
    return None


def loaded_libraries(
    maps_text: str, names: tuple[str, ...] = UNLOADED_LIBRARIES
) -> list[str]:
    """Each name that appears in a memory-mapped file path of the process."""
    paths = [
        line.split(None, 5)[5]
        for line in maps_text.splitlines()
        if len(line.split(None, 5)) == 6
    ]
    return sorted(
        {name for name in names for path in paths if name in path.rsplit("/", 1)[-1]}
    )


def telemetry_off(command_line: str) -> bool:
    """PID 1 is the server and it was started with telemetry disabled."""
    arguments = command_line.split("\0")
    return (
        bool(arguments)
        and arguments[0] == "mysqld"
        and "--percona_telemetry_disable=1" in arguments
    )


def run(arguments: list[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments, capture_output=True, text=True, timeout=timeout, check=False
    )


def check(image: str) -> list[str]:
    """The failures found, empty when the image passes."""
    name = f"percona-smoke-{uuid.uuid4().hex[:12]}"
    failures: list[str] = []
    started = run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            name,
            "--env",
            "MYSQL_ALLOW_EMPTY_PASSWORD=1",
            image,
        ]
    )
    if started.returncode != 0:
        return [f"the container did not start: {started.stderr.strip()}"]
    try:
        deadline = time.monotonic() + READY_TIMEOUT_SECONDS
        while True:
            logs = run(["docker", "logs", name])
            if ready(logs.stdout + logs.stderr):
                break
            if time.monotonic() > deadline:
                return ["the server was not ready for connections in time"]
            if (
                run(
                    ["docker", "inspect", "--format", "{{.State.Running}}", name]
                ).stdout.strip()
                != "true"
            ):
                return ["the container stopped before the server was ready"]
            time.sleep(2)

        sql = run(
            [
                "docker",
                "exec",
                name,
                "mysql",
                "-uroot",
                "-N",
                "-B",
                "-e",
                "SELECT VERSION(); SHOW VARIABLES LIKE 'percona_telemetry_disable'",
            ]
        )
        rows = sql.stdout.splitlines()
        if sql.returncode != 0 or not rows or not rows[0].startswith(EXPECTED_VERSION):
            failures.append(
                f"the server does not report {EXPECTED_VERSION}: {sql.stdout.strip() or sql.stderr.strip()}"
            )
        if variable_value(sql.stdout, "percona_telemetry_disable") != "ON":
            failures.append("percona_telemetry_disable is not ON")

        cmdline = run(["docker", "exec", name, "cat", "/proc/1/cmdline"]).stdout
        if not telemetry_off(cmdline):
            failures.append(
                f"PID 1 is not mysqld started with telemetry disabled: {cmdline!r}"
            )

        for package in REMOVED_PACKAGES:
            if run(["docker", "exec", name, "rpm", "-q", package]).returncode == 0:
                failures.append(f"{package} is still installed")
        for path in ("/call-home.sh", "/usr/bin/telemetry-agent-supervisor.sh"):
            if run(["docker", "exec", name, "ls", path]).returncode == 0:
                failures.append(f"{path} is still present")

        maps = run(["docker", "exec", name, "cat", "/proc/1/maps"])
        loaded = loaded_libraries(maps.stdout)
        if maps.returncode != 0 or not maps.stdout:
            failures.append("the server's memory map could not be read")
        if loaded:
            failures.append(f"the running server has loaded: {', '.join(loaded)}")
    finally:
        run(["docker", "rm", "--force", name])
    return failures


def main(arguments: list[str]) -> int:
    if len(arguments) != 1:
        print("usage: smoke_check.py IMAGE", file=sys.stderr)
        return 2
    failures = check(arguments[0])
    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    if not failures:
        print(
            f"ok: {arguments[0]} starts, reports {EXPECTED_VERSION}, has telemetry off and the removed parts gone"
        )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
