"""A thin, typed layer over the `docker` command line for the contract harness.

Everything the harness starts carries one label, so a run that dies half way
leaves nothing behind that `cleanup()` cannot find. Nothing here knows about
ActivityPub.
"""

from __future__ import annotations

import http.client
import json
import socket
import ssl
import subprocess
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Self

LABEL_KEY = "branchleft.agent"
LABEL_VALUE = "activitypub-contract"


class DockerError(RuntimeError):
    """A docker command failed; the message carries its output."""


def docker(*args: str, check: bool = True, timeout: float = 600.0, stdin: str | None = None) -> str:
    """Run `docker <args>`; return stdout. With `check` a failure raises DockerError."""
    done = subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        input=stdin,
        check=False,
    )
    if check and done.returncode != 0:
        raise DockerError(
            f"docker {' '.join(args[:3])} failed ({done.returncode}): {done.stderr.strip()[-2000:]}"
        )
    return done.stdout + (done.stderr if not check else "")


def wait_until(
    probe: Callable[[], bool],
    *,
    seconds: float,
    what: str,
    every: float = 0.5,
) -> None:
    """Poll `probe` until it is true, or raise with `what` after `seconds`."""
    deadline = time.monotonic() + seconds
    while True:
        try:
            if probe():
                return
        except (OSError, http.client.HTTPException, DockerError):
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError(f"timed out after {seconds:.0f}s waiting for {what}")
        time.sleep(every)


@dataclass
class Lab:
    """One throwaway network and the containers started on it."""

    run_id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    containers: list[str] = field(default_factory=list)

    @property
    def network(self) -> str:
        return f"apc-{self.run_id}"

    def __enter__(self) -> Self:
        docker("network", "create", "--label", f"{LABEL_KEY}={LABEL_VALUE}", self.network)
        return self

    def __exit__(self, *_exc: object) -> None:
        self.cleanup()

    def name(self, role: str) -> str:
        return f"apc-{self.run_id}-{role}"

    def cleanup(self) -> None:
        for name in self.containers:
            docker("rm", "-f", "-v", name, check=False)
        self.containers.clear()
        docker("network", "rm", self.network, check=False)

    def start(
        self,
        role: str,
        image: str,
        *,
        env: Mapping[str, str] | None = None,
        aliases: Sequence[str] = (),
        publish: Sequence[int] = (),
        copies: Sequence[tuple[str, str]] = (),
        extra: Sequence[str] = (),
        command: Sequence[str] = (),
        entrypoint: str | None = None,
    ) -> str:
        """Start a detached container named for `role`; return its name.

        `copies` are (host path, container path) pairs put in with `docker cp`
        before the start, because a bind mount of a temporary directory can
        hang Docker Desktop.
        """
        name = self.name(role)
        argv = [
            "create",
            "--name",
            name,
            "--network",
            self.network,
            "--label",
            f"{LABEL_KEY}={LABEL_VALUE}",
        ]
        argv += ["--network-alias", role]
        for alias in aliases:
            argv += ["--network-alias", alias]
        for port in publish:
            argv += ["-p", f"127.0.0.1::{port}"]
        for key, value in (env or {}).items():
            argv += ["-e", f"{key}={value}"]
        if entrypoint is not None:
            argv += ["--entrypoint", entrypoint]
        argv += list(extra)
        argv.append(image)
        argv += list(command)
        docker(*argv)
        self.containers.append(name)
        for source, target in copies:
            docker("cp", source, f"{name}:{target}")
        docker("start", name)
        return name

    def run_once(
        self,
        image: str,
        *,
        env: Mapping[str, str] | None = None,
        command: Sequence[str] = (),
        timeout: float = 300.0,
    ) -> tuple[int, str]:
        """Run a container to completion on the lab network; return (exit code, output)."""
        argv = ["run", "--rm", "--network", self.network, "--label", f"{LABEL_KEY}={LABEL_VALUE}"]
        for key, value in (env or {}).items():
            argv += ["-e", f"{key}={value}"]
        argv.append(image)
        argv += list(command)
        done = subprocess.run(
            ["docker", *argv], capture_output=True, text=True, timeout=timeout, check=False
        )
        return done.returncode, done.stdout + done.stderr


def host_port(name: str, container_port: int) -> int:
    """The loopback port Docker published for `container_port` of `name`."""
    out = docker("port", name, f"{container_port}/tcp").strip().splitlines()
    for line in out:
        if line.startswith("127.0.0.1:"):
            return int(line.rsplit(":", 1)[1])
    raise DockerError(f"{name} publishes no loopback port for {container_port}: {out!r}")


def logs(name: str) -> str:
    return docker("logs", name, check=False)


def is_running(name: str) -> bool:
    out = docker("inspect", "-f", "{{.State.Running}}", name, check=False).strip()
    return out == "true"


def exit_code(name: str) -> int:
    return int(docker("inspect", "-f", "{{.State.ExitCode}}", name).strip())


def exec_in(name: str, *argv: str, check: bool = True) -> str:
    return docker("exec", name, *argv, check=check)


@dataclass(frozen=True)
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes
    set_cookies: tuple[str, ...] = ()

    @property
    def cookie_header(self) -> str:
        """The `Cookie` request header that returns every cookie this response set."""
        return "; ".join(value.split(";", 1)[0] for value in self.set_cookies)

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> object:
        return json.loads(self.body.decode("utf-8"))


def http_request(
    port: int,
    method: str,
    path: str,
    *,
    host: str | None,
    headers: Mapping[str, str] | None = None,
    body: bytes = b"",
    tls_ca: str | None = None,
    sni: str | None = None,
    timeout: float = 20.0,
) -> Response:
    """One request to 127.0.0.1:`port` with an exact Host header (None sends no Host at all).

    With `tls_ca` the connection is HTTPS, verified against that CA file and the
    `sni` name. Redirects are never followed: the status is the answer.
    """
    conn: http.client.HTTPConnection
    if tls_ca is not None:
        context = ssl.create_default_context(cafile=tls_ca)
        raw = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        wrapped = context.wrap_socket(raw, server_hostname=sni or host)
        conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=timeout, context=context)
        conn.sock = wrapped
    else:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        if host is not None:
            conn.putheader("Host", host)
        for key, value in (headers or {}).items():
            conn.putheader(key, value)
        if body or method in ("POST", "PUT"):
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
        answer = conn.getresponse()
        data = answer.read()
        pairs = answer.getheaders()
        return Response(
            answer.status,
            {k.lower(): v for k, v in pairs},
            data,
            tuple(v for k, v in pairs if k.lower() == "set-cookie"),
        )
    finally:
        conn.close()
