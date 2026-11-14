#!/usr/bin/python3 -I
# Carries each app host's support-access textfile into the portal, once a minute
# (branchleft-support-access-collect.timer). Installed root-owned, mode 0700, at
# /usr/local/sbin/branchleft-support-access-collect, on ops1. See
# branchleft-support-access-collect.md for why it is a native program, what it
# runs, and the one rule that a host it could not read is never written as closed.
from __future__ import annotations

import dataclasses
import http.client
import ipaddress
import re
import subprocess
import sys
import time
import urllib.parse

PROG = 'branchleft-support-access-collect'
DOCKER = '/usr/bin/docker'

# The one container the portal's collector runs in: the owner console's, which
# already holds the database URL the collector writes with.
PROJECT_LABEL = 'com.docker.compose.project'
SERVICE_LABEL = 'com.docker.compose.service'
PROJECT = 'control-plane'
SERVICE = 'console'
PS_FORMAT = '{{.ID}}'
CONTAINER_ID = re.compile(r'[0-9a-f]{12,64}')
COLLECTOR = ('node', 'dist/collector/main.js')

# What the children get: no inherited environment, so no DOCKER_HOST or the like.
CHILD_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}

METRICS_PATH = '/metrics'
MAX_BODY_BYTES = 1024 * 1024
MAX_CHILD_LOG_BYTES = 64 * 1024
USAGE_EXIT = 2


@dataclasses.dataclass(frozen=True)
class Config:
    docker: str = DOCKER
    # The whole fetch of one host, connect to last byte, so one slow host cannot hold the minute.
    fetch_timeout_s: float = 10.0
    list_timeout_s: float = 30.0
    exec_timeout_s: float = 60.0


@dataclasses.dataclass(frozen=True)
class Target:
    host: str
    port: int


class UsageError(Exception):
    """An exporter address that is not a private IPv4 address and port with the metrics path."""


class NotRead(Exception):
    """A host that could not be read. The message is fixed text, never what the host sent."""


def log(message: str) -> None:
    sys.stderr.write(f'{PROG}: {message}\n')


def parse_target(argument: str) -> Target:
    """`http://<private IPv4>:<port>/metrics` and nothing else: no name, no login, no query, no other scheme."""
    try:
        parts = urllib.parse.urlsplit(argument)
        port = parts.port
        host = parts.hostname
    except ValueError:
        raise UsageError('an exporter address is not a URL') from None
    if parts.scheme != 'http' or parts.username is not None or parts.password is not None:
        raise UsageError('an exporter address must be plain http with no login')
    if parts.path != METRICS_PATH or parts.query or parts.fragment:
        raise UsageError(f'an exporter address must end in {METRICS_PATH}, with nothing after it')
    if host is None or port is None or not 0 < port < 65536:
        raise UsageError('an exporter address needs an address and a port')
    try:
        address = ipaddress.IPv4Address(host)
    except ValueError:
        raise UsageError('an exporter address must be an IPv4 address, not a name') from None
    if not address.is_private:
        raise UsageError('an exporter address must be a private address')
    return Target(str(address), port)


def run(
    argv: list[str], timeout_s: float, stdin: bytes | None = None
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        argv,
        input=stdin,
        stdin=subprocess.DEVNULL if stdin is None else None,
        capture_output=True,
        timeout=timeout_s,
        check=False,
        env=CHILD_ENV,
    )


def fetch(cfg: Config, target: Target) -> bytes:
    """One host's exporter text, or NotRead. No redirect is followed and no proxy is used."""
    deadline = time.monotonic() + cfg.fetch_timeout_s
    connection = http.client.HTTPConnection(target.host, target.port, timeout=cfg.fetch_timeout_s)
    try:
        connection.request('GET', METRICS_PATH, headers={'Accept': 'text/plain'})
        response = connection.getresponse()
        if response.status != 200:
            raise NotRead(f'the exporter answered {response.status}')
        body = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise NotRead('the exporter was too slow')
            chunk = response.read(8192)
            if not chunk:
                return bytes(body)
            body.extend(chunk)
            if len(body) > MAX_BODY_BYTES:
                raise NotRead('the exporter text is too long')
    except (OSError, http.client.HTTPException) as exc:
        raise NotRead(f'the exporter could not be read: {type(exc).__name__}') from None
    finally:
        connection.close()


def find_collector_container(cfg: Config) -> str:
    """The id of the one running console container, or NotRead."""
    argv = [
        cfg.docker, 'ps', '--filter', 'status=running',
        '--filter', f'label={PROJECT_LABEL}={PROJECT}',
        '--filter', f'label={SERVICE_LABEL}={SERVICE}',
        '--format', PS_FORMAT,
    ]
    try:
        done = run(argv, cfg.list_timeout_s)
    except (OSError, subprocess.SubprocessError) as exc:
        raise NotRead(f'the console container could not be listed: {type(exc).__name__}') from None
    if done.returncode != 0:
        raise NotRead(f'docker ps exit {done.returncode}')
    ids = done.stdout.decode('utf-8', 'replace').split()
    if len(ids) != 1 or CONTAINER_ID.fullmatch(ids[0]) is None:
        raise NotRead(f'{len(ids)} running console containers, not one')
    return ids[0]


def hand_over(cfg: Config, container: str, text: bytes) -> bool:
    """Pipes one host's text to the collector inside the console container. True when it exited 0."""
    argv = [cfg.docker, 'exec', '-i', container, *COLLECTOR]
    try:
        done = run(argv, cfg.exec_timeout_s, stdin=text)
    except (OSError, subprocess.SubprocessError) as exc:
        log(f'the collector did not run: {type(exc).__name__}')
        return False
    # The collector's own lines (one per tenant, no reason, clock or id) are the run log.
    sys.stderr.write(done.stderr[:MAX_CHILD_LOG_BYTES].decode('utf-8', 'replace'))
    if done.returncode != 0:
        log(f'the collector exited {done.returncode}')
        return False
    return True


def main(argv: list[str], cfg: Config | None = None) -> int:
    cfg = cfg or Config()
    if not argv:
        log('usage: branchleft-support-access-collect http://<address>:<port>/metrics ...')
        return USAGE_EXIT
    try:
        targets = [parse_target(argument) for argument in argv]
    except UsageError as exc:
        log(str(exc))
        return USAGE_EXIT

    ok = True
    container: str | None = None
    for target in targets:
        label = f'{target.host}:{target.port}'
        try:
            text = fetch(cfg, target)
        except NotRead as exc:
            # Nothing is handed over for this host: its tenants keep no new reading
            # and the page reads them as unknown once the old one is too old.
            log(f'{label}: nothing written: {exc}')
            ok = False
            continue
        try:
            container = container or find_collector_container(cfg)
        except NotRead as exc:
            log(f'{label}: nothing written: {exc}')
            ok = False
            continue
        if not hand_over(cfg, container, text):
            ok = False
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
