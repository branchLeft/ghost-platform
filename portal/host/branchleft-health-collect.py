#!/usr/bin/python3 -I
# Carries each tenant's drain-sidecar health into the portal, once a minute
# (branchleft-health-collect.timer). Installed root-owned, mode 0700, at
# /usr/local/sbin/branchleft-health-collect, on ops1. See
# branchleft-health-collect.md for why it is a native program, what it runs, and
# the one rule that a colour it could not read is never written as healthy.
from __future__ import annotations

import dataclasses
import http.client
import ipaddress
import json
import re
import subprocess
import sys
import time
import urllib.parse

PROG = 'branchleft-health-collect'
DOCKER = '/usr/bin/docker'

# The one container the portal's collector runs in: the owner console's, which
# already holds the database URL the collector writes with.
PROJECT_LABEL = 'com.docker.compose.project'
SERVICE_LABEL = 'com.docker.compose.service'
PROJECT = 'control-plane'
SERVICE = 'console'
PS_FORMAT = '{{.ID}}'
CONTAINER_ID = re.compile(r'[0-9a-f]{12,64}')
COLLECTOR = ('node', 'dist/collector/healthMain.js')

# What the children get: no inherited environment, so no DOCKER_HOST or the like.
CHILD_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}

METRICS_PATH = '/metrics'
# A sidecar's text is a dozen short lines. The collector refuses a colour longer
# than this (MAX_SCRAPE_CHARS in healthReport.ts), so a longer one is not read.
MAX_BODY_BYTES = 16 * 1024
MAX_COLOURS = 2
MAX_CHILD_LOG_BYTES = 64 * 1024
USAGE_EXIT = 2

# The same shape a tenant name has (TENANT_NAME_PATTERN): a slug and nothing else.
SLUG = re.compile(r'[a-z][a-z0-9-]{1,24}[a-z0-9]')


@dataclasses.dataclass(frozen=True)
class Config:
    docker: str = DOCKER
    # The whole fetch of one colour, connect to last byte, so one slow colour cannot hold the minute.
    fetch_timeout_s: float = 5.0
    list_timeout_s: float = 30.0
    exec_timeout_s: float = 60.0


@dataclasses.dataclass(frozen=True)
class Target:
    host: str
    port: int


@dataclasses.dataclass(frozen=True)
class Tenant:
    slug: str
    colours: tuple[Target, ...]


class UsageError(Exception):
    """An argument that is not `<slug>=<address>[,<address>]` over private IPv4 addresses."""


class NotRead(Exception):
    """A colour that could not be read. The message is fixed text, never what the colour sent."""


def log(message: str) -> None:
    sys.stderr.write(f'{PROG}: {message}\n')


def parse_target(address: str) -> Target:
    """`http://<private IPv4>:<port>/metrics` and nothing else: no name, no login, no query, no other scheme."""
    try:
        parts = urllib.parse.urlsplit(address)
        port = parts.port
        host = parts.hostname
    except ValueError:
        raise UsageError('a sidecar address is not a URL') from None
    if parts.scheme != 'http' or parts.username is not None or parts.password is not None:
        raise UsageError('a sidecar address must be plain http with no login')
    if parts.path != METRICS_PATH or parts.query or parts.fragment:
        raise UsageError(f'a sidecar address must end in {METRICS_PATH}, with nothing after it')
    if host is None or port is None or not 0 < port < 65536:
        raise UsageError('a sidecar address needs an address and a port')
    try:
        ip = ipaddress.IPv4Address(host)
    except ValueError:
        raise UsageError('a sidecar address must be an IPv4 address, not a name') from None
    if not ip.is_private:
        raise UsageError('a sidecar address must be a private address')
    return Target(str(ip), port)


def parse_tenant(argument: str) -> Tenant:
    slug, separator, rest = argument.partition('=')
    if not separator or SLUG.fullmatch(slug) is None:
        raise UsageError('an argument is <tenant slug>=<address>[,<address>]')
    addresses = rest.split(',')
    if not 1 <= len(addresses) <= MAX_COLOURS:
        raise UsageError(f'a tenant has one or two colours, not {len(addresses)}')
    return Tenant(slug, tuple(parse_target(address) for address in addresses))


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


def fetch(cfg: Config, target: Target) -> str:
    """One colour's sidecar text, or NotRead. No redirect is followed and no proxy is used."""
    deadline = time.monotonic() + cfg.fetch_timeout_s
    connection = http.client.HTTPConnection(target.host, target.port, timeout=cfg.fetch_timeout_s)
    try:
        connection.request('GET', METRICS_PATH, headers={'Accept': 'text/plain'})
        response = connection.getresponse()
        if response.status != 200:
            raise NotRead(f'the sidecar answered {response.status}')
        body = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise NotRead('the sidecar was too slow')
            chunk = response.read(4096)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > MAX_BODY_BYTES:
                raise NotRead('the sidecar text is too long')
    except (OSError, http.client.HTTPException) as exc:
        raise NotRead(f'the sidecar could not be read: {type(exc).__name__}') from None
    finally:
        connection.close()
    try:
        return bytes(body).decode('utf-8')
    except UnicodeDecodeError:
        raise NotRead('the sidecar text is not UTF-8') from None


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


def read_tenant(cfg: Config, tenant: Tenant) -> tuple[list[str | None], bool]:
    """One entry per colour, None where it was not read, and whether every colour was read."""
    scrapes: list[str | None] = []
    complete = True
    for colour, target in zip('ab', tenant.colours):
        try:
            scrapes.append(fetch(cfg, target))
        except NotRead as exc:
            # The collector writes this tenant as unknown: the colour that did answer is
            # not enough to say which colour serves.
            log(f'{tenant.slug}: colour {colour} not read: {exc}')
            scrapes.append(None)
            complete = False
    return scrapes, complete


def hand_over(cfg: Config, container: str, report: bytes) -> bool:
    """Pipes the report to the collector inside the console container. True when it exited 0."""
    argv = [cfg.docker, 'exec', '-i', container, *COLLECTOR]
    try:
        done = run(argv, cfg.exec_timeout_s, stdin=report)
    except (OSError, subprocess.SubprocessError) as exc:
        log(f'the collector did not run: {type(exc).__name__}')
        return False
    # The collector's own lines (one per tenant, no scrape, version or id) are the run log.
    sys.stderr.write(done.stderr[:MAX_CHILD_LOG_BYTES].decode('utf-8', 'replace'))
    if done.returncode != 0:
        log(f'the collector exited {done.returncode}')
        return False
    return True


def main(argv: list[str], cfg: Config | None = None) -> int:
    cfg = cfg or Config()
    if not argv:
        log('usage: branchleft-health-collect <tenant slug>=http://<address>:<port>/metrics[,<address>] ...')
        return USAGE_EXIT
    try:
        tenants = [parse_tenant(argument) for argument in argv]
    except UsageError as exc:
        log(str(exc))
        return USAGE_EXIT
    if len({tenant.slug for tenant in tenants}) != len(tenants):
        log('a tenant slug is named twice')
        return USAGE_EXIT

    # A colour that cannot be read is still reported, as null, so the portal's old reading
    # of that tenant is replaced with unknown rather than left to read as healthy.
    ok = True
    entries: list[dict[str, object]] = []
    for tenant in tenants:
        scrapes, complete = read_tenant(cfg, tenant)
        ok = ok and complete
        entries.append({'tenant': tenant.slug, 'scrapes': scrapes})
    report = json.dumps({'tenants': entries}).encode('utf-8')

    try:
        container = find_collector_container(cfg)
    except NotRead as exc:
        log(f'nothing written: {exc}')
        return 1
    return 0 if hand_over(cfg, container, report) and ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
