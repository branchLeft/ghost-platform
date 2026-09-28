#!/usr/bin/env python3
"""The one channel an org/control-side worker dials a tenant host over:
`DialInTransport` (the interface), `LocalProcessTransport` (a local test
double), and `DumpEndpointTransport` (the real channel, dialling
`db/provision/dump_endpoint_server.py`). Design and rationale:
`db/provision/dump-endpoint.md`.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from typing import BinaryIO, Protocol

# Every prefix naming a storage or encryption credential in this estate's
# convention, restated from db/provision/dump_tenant.py's own
# FORBIDDEN_ENV_PREFIXES rather than imported: this module is the
# org/control side of the same trust boundary, checking the same property
# independently. None of AWS_* / DB_BACKUP_* / AGE_* may ever reach the
# environment a producer command is invoked with.
FORBIDDEN_ENV_PREFIXES = ("AWS_", "DB_BACKUP_", "AGE_")

# What a local subprocess is allowed to see beyond the caller's own,
# explicit env dict -- PATH only, so a binary can be resolved by name.
# Never a forward of this process's own os.environ: the worker legitimately
# holds AWS_*/AGE_* itself (for the storage and encryption calls
# `pull_encrypt_store.py` makes), and an allowlist is the only shape that
# cannot leak them into a producer invocation by accident.
_CHILD_ENV_ALLOWLIST = ("PATH",)

# `db/provision/naming.py`'s own `TENANT_NAME_PATTERN`, restated rather than
# imported -- same reasoning as `FORBIDDEN_ENV_PREFIXES` above: this module
# is on the org/control side of the trust boundary, and it is the layer
# that puts a tenant name into a URL, so it checks that value itself rather
# than trusting whatever validated it (if anything did) on its way here.
TENANT_NAME_PATTERN = re.compile(r"\A[a-z]([a-z0-9-]*[a-z0-9])?\Z")


class DialInTransportError(Exception):
    """The transport itself could not run the producer at all -- distinct
    from the producer's own nonzero exit, which is an ordinary, expected
    outcome this pipeline handles by discarding whatever streamed."""


def assert_no_forbidden_env(env: Mapping[str, str]) -> None:
    """Refuses an env dict carrying a storage or encryption credential
    prefix, before it ever reaches a transport. `pull_encrypt_store.py`
    calls this exact function too, at its own boundary -- two call sites
    sharing one implementation, not two independent ones: a bug in this
    function would defeat the check at both sites at once. The two-call-site
    shape still matters -- a caller of either module gets the refusal at
    the earliest point it invokes -- but it is not defense in depth against
    a defect in this function itself."""
    present = sorted(name for name in env if name.startswith(FORBIDDEN_ENV_PREFIXES))
    if present:
        raise DialInTransportError(
            "refusing to dial in: the environment a producer would be invoked with carries "
            f"{', '.join(present)} -- the per-tenant dump producer's own caller contract is "
            "that this invocation channel must never carry a storage or encryption "
            "credential, regardless of whether the producer at the other end would refuse "
            "to start with one present"
        )


class DialInTransport(Protocol):
    """One call: run `command` with exactly `env` (nothing else, nothing
    ambient), stream its stdout to `stdout` as it arrives, and return the
    exit code once the process ends. A caller decides what to do with a
    nonzero exit; this interface only ever reports it faithfully."""

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int: ...


class LocalProcessTransport:
    """A TEST DOUBLE, not the production channel: proves the pipeline's
    controls against a real local producer and database without a network
    hop. Streams line-by-line, mirroring `dump_tenant.py`'s own
    `run_mysqldump`, since a caller watching for a floor-table `INSERT`
    needs whole lines.
    """

    def __init__(self, *, popen=subprocess.Popen) -> None:
        self._popen = popen

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int:
        assert_no_forbidden_env(env)
        child_env = {name: os.environ[name] for name in _CHILD_ENV_ALLOWLIST if name in os.environ}
        child_env.update(env)

        process = self._popen(list(command), env=child_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for line in process.stdout:
                stdout.write(line)
        finally:
            process.stdout.close()
        process.stderr.close()
        return process.wait()



# The pattern `run_tenant_dump` builds its own `command` argument with --
# see backup_worker.py: `[python_executable, dump_tenant_path, tenant,
# "--socket", socket_path]`. `DumpEndpointTransport` cannot forward
# `command` itself across the wire (a small HTTP endpoint that ran
# whatever argv a caller handed it would be exactly the command-injection
# surface `dump_endpoint_server.py`'s own "never lets a caller name a
# path" rule exists to close); the tenant name is the only thing it
# extracts from `command`, at this fixed position.
_TENANT_COMMAND_INDEX = 2


def _tenant_from_command(command: Sequence[str]) -> str:
    if len(command) <= _TENANT_COMMAND_INDEX:
        raise DialInTransportError(
            f"cannot dial the dump endpoint: {list(command)!r} is shorter than the "
            "[python, dump_tenant_path, tenant, ...] shape run_tenant_dump always builds"
        )
    return command[_TENANT_COMMAND_INDEX]


class DumpEndpointTransport:
    """The real dial-in channel: fetches one tenant's dump from
    `dump_endpoint_server.py` over plain HTTP, with the same bearer-token
    authentication that server enforces. Re-validates the tenant
    independently rather than trusting `run_tenant_dump` already did, and
    treats a response shorter than its own declared `Content-Length` as a
    failure, never a 0 exit. Design: `db/provision/dump-endpoint.md`.
    """

    def __init__(
        self,
        *,
        base_url: str,
        bearer_token: str,
        timeout_seconds: float = 30.0,
        urlopen=urllib.request.urlopen,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._timeout_seconds = timeout_seconds
        self._urlopen = urlopen

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int:
        assert_no_forbidden_env(env)
        tenant = _tenant_from_command(command)
        if not TENANT_NAME_PATTERN.match(tenant):
            raise DialInTransportError(
                f"refusing to dial in: {tenant!r} is not a strictly valid tenant slug"
            )
        mysql_pwd = env.get("DB_DUMP_MYSQL_PWD")
        if not mysql_pwd:
            raise DialInTransportError(
                "refusing to dial in: env carries no DB_DUMP_MYSQL_PWD -- the dump endpoint "
                "needs it in every request, since the tenant database host holds none at rest"
            )

        url = f"{self._base_url}/dump/{tenant}"
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self._bearer_token}",
                "X-Db-Dump-Mysql-Pwd": mysql_pwd,
            },
        )

        try:
            response = self._urlopen(request, timeout=self._timeout_seconds)
        except urllib.error.HTTPError as exc:
            with exc:
                return self._handle_error_response(exc, url=url)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise DialInTransportError(f"dialling {url} failed: {exc}") from exc

        with response:
            expected_length = response.headers.get("Content-Length")
            if expected_length is None:
                raise DialInTransportError(
                    f"the dump endpoint at {url} sent no Content-Length on a 200 -- refusing to "
                    "trust a body this class cannot check for completeness"
                )
            bytes_read = 0
            try:
                for line in response:
                    bytes_read += len(line)
                    stdout.write(line)
            except (http.client.HTTPException, ConnectionError, OSError) as exc:
                raise DialInTransportError(
                    f"the dump stream from {url} broke before completing: {exc}"
                ) from exc

        if bytes_read != int(expected_length):
            raise DialInTransportError(
                f"the dump stream from {url} ended after {bytes_read} bytes, expected exactly "
                f"{expected_length} (Content-Length) -- refusing to treat a truncated dump as "
                "a successful 0 exit"
            )
        return 0

    def _handle_error_response(self, exc: urllib.error.HTTPError, *, url: str) -> int:
        body = exc.read()
        if exc.code == 502:
            try:
                payload = json.loads(body)
                exit_code = int(payload["exit_code"])
            except (ValueError, KeyError, TypeError):
                raise DialInTransportError(
                    f"dump endpoint at {url} reported a producer failure (502) but the body "
                    f"was not the expected {{'exit_code': ...}} shape: {body!r}"
                ) from None
            if exit_code == 0:
                # dump_endpoint_server.py only ever sends 502 from a caught
                # DumpError, which always reports exit_code 1 -- a 502
                # carrying 0 is not a shape the real server produces, and
                # guessing 0 here would tell pull_encrypt_store.py to store
                # a dump this response never actually delivered.
                raise DialInTransportError(
                    f"dump endpoint at {url} returned 502 but exit_code 0, a contradiction -- "
                    "refusing to report this as a successful 0 exit"
                )
            return exit_code
        raise DialInTransportError(
            f"dump endpoint at {url} returned {exc.code}, not 200 or 502: {body!r}"
        )
