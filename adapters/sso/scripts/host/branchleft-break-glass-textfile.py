#!/usr/bin/python3 -I
# Writes each tenant's support-access state to one node_exporter textfile, once a
# minute (branchleft-break-glass-textfile.timer). Installed root-owned, mode 0700,
# at /usr/local/sbin/branchleft-break-glass-textfile. See
# branchleft-break-glass-textfile.md for the file's series, the one rule that a
# tenant it could not read has no series, and what it never runs.
from __future__ import annotations

import dataclasses
import datetime
import json
import os
import re
import secrets
import subprocess
import sys

PROG = 'branchleft-break-glass-textfile'
WRAPPER = '/usr/local/sbin/branchleft-break-glass'
DOCKER = '/usr/bin/docker'
OUTPUT_DIR = '/var/lib/branchleft/support-access-exporter'
OUTPUT_NAME = 'support_access.prom'

# The one Compose label that names a tenant, and the two services that are its Ghost.
# The grant tool finds a tenant's container the same way.
PROJECT_LABEL = 'com.docker.compose.project'
SERVICE_LABEL = 'com.docker.compose.service'
GHOST_SERVICES = ('ghost-a', 'ghost-b')
PS_FORMAT = '{{.Label "' + PROJECT_LABEL + '"}}\t{{.Label "' + SERVICE_LABEL + '"}}'

# What the children get: no inherited environment, so no DOCKER_HOST or the like.
CHILD_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}

TENANT = re.compile(r'[a-z0-9][a-z0-9-]{0,62}')
STATES = ('open', 'closed', 'unknown')
LANES = ('consented', 'incident')
REPORT_KEYS = frozenset({'tenant', 'state', 'lane', 'grantedAt', 'deadline', 'observedAt'})
MAX_REPORT_BYTES = 4096
TIMESTAMP = re.compile(r'([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?Z')


@dataclasses.dataclass(frozen=True)
class Config:
    wrapper: str = WRAPPER
    docker: str = DOCKER
    output_dir: str = OUTPUT_DIR
    # Each call is bounded so one stuck tenant cannot hold the minute for the rest.
    report_timeout_s: float = 30.0
    list_timeout_s: float = 30.0


@dataclasses.dataclass(frozen=True)
class Reading:
    tenant: str
    state: str
    lane: str | None
    granted_ms: int | None
    deadline_ms: int | None
    observed_ms: int


class ListError(Exception):
    """The running tenants could not be listed."""


class ReportRefusedError(Exception):
    """A report that is not the one-line JSON the grant tool prints. The message is fixed text, never the report."""


def log(message: str) -> None:
    sys.stderr.write(f'{PROG}: {message}\n')


def run(argv: list[str], timeout_s: float) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        argv,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=timeout_s,
        check=False,
        env=CHILD_ENV,
    )


def list_tenants(cfg: Config) -> list[str]:
    """The slug of every tenant with a running Ghost container, either colour, once each."""
    argv = [
        cfg.docker, 'ps', '--filter', 'status=running', '--filter', f'label={SERVICE_LABEL}',
        '--format', PS_FORMAT,
    ]
    try:
        done = run(argv, cfg.list_timeout_s)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ListError(type(exc).__name__) from exc
    if done.returncode != 0:
        raise ListError(f'docker ps exit {done.returncode}')
    slugs = set()
    for line in done.stdout.decode('utf-8', 'replace').splitlines():
        fields = line.split('\t')
        if len(fields) != 2:
            continue
        project, service = fields
        if service in GHOST_SERVICES and TENANT.fullmatch(project):
            slugs.add(project)
    return sorted(slugs)


def timestamp_ms(value: object) -> int:
    if not isinstance(value, str):
        raise ReportRefusedError('a time is not text')
    match = TIMESTAMP.fullmatch(value)
    if match is None:
        raise ReportRefusedError('a time is not an ISO 8601 UTC time')
    try:
        base = datetime.datetime.strptime(match.group(1), '%Y-%m-%dT%H:%M:%S')
    except ValueError as exc:
        raise ReportRefusedError('a time is not a real date') from exc
    seconds = int(base.replace(tzinfo=datetime.timezone.utc).timestamp())
    if seconds < 0:
        raise ReportRefusedError('a time is before 1970')
    return seconds * 1000 + int((match.group(2) or '0').ljust(3, '0')[:3])


def no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise ReportRefusedError('a key is repeated')
    return dict(pairs)


def parse_report(slug: str, raw: bytes) -> Reading:
    """The report as one Reading, or ReportRefusedError. Anything not exactly the documented shape is refused whole."""
    if len(raw) > MAX_REPORT_BYTES:
        raise ReportRefusedError('the report is too long')
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        raise ReportRefusedError('the report is not UTF-8') from None
    body = text.removesuffix('\n')
    if '\n' in body or '\r' in body:
        raise ReportRefusedError('the report is not one line')
    try:
        obj = json.loads(body, object_pairs_hook=no_duplicate_keys)
    except (ValueError, RecursionError):
        raise ReportRefusedError('the report is not JSON') from None
    if not isinstance(obj, dict):
        raise ReportRefusedError('the report is not an object')
    # The exact keys, no more: a field the tool is not documented to print is refused,
    # never copied.
    if set(obj) != REPORT_KEYS:
        raise ReportRefusedError('the report does not have exactly the documented fields')
    if obj['tenant'] != slug:
        raise ReportRefusedError('the report is for another tenant')
    state, lane = obj['state'], obj['lane']
    if not isinstance(state, str) or state not in STATES:
        raise ReportRefusedError('the state is not open, closed or unknown')
    if lane is not None and (not isinstance(lane, str) or lane not in LANES):
        raise ReportRefusedError('the lane is not consented or incident')
    granted = None if obj['grantedAt'] is None else timestamp_ms(obj['grantedAt'])
    deadline = None if obj['deadline'] is None else timestamp_ms(obj['deadline'])
    if state != 'open' and (lane, granted, deadline) != (None, None, None):
        raise ReportRefusedError('a grant clock on an account that is not open')
    return Reading(slug, state, lane, granted, deadline, timestamp_ms(obj['observedAt']))


def read_tenant(cfg: Config, slug: str) -> Reading | None:
    """The tenant's reading, or None when it could not be read for any reason."""
    try:
        done = run([cfg.wrapper, 'report', '--tenant', slug], cfg.report_timeout_s)
        if done.returncode != 0:
            raise ReportRefusedError(f'report exit {done.returncode}')
        return parse_report(slug, done.stdout)
    except ReportRefusedError as exc:
        log(f'{slug}: no series: {exc}')
    except (OSError, subprocess.SubprocessError) as exc:
        log(f'{slug}: no series: {type(exc).__name__}')
    return None


def seconds(ms: int) -> str:
    return f'{ms // 1000}.{ms % 1000:03d}'


def render(readings: list[Reading]) -> str:
    """The textfile. Labels are slugs and the two lanes only, so nothing needs escaping."""
    ordered = sorted(readings, key=lambda reading: reading.tenant)
    for reading in ordered:
        if not TENANT.fullmatch(reading.tenant):
            raise ValueError('a tenant name that is not a slug')
    families: list[tuple[str, str, list[str]]] = [
        (
            'branchleft_support_access_state',
            (
                "The tenant's support account as the host's report read it: open, closed or unknown. "
                'A tenant with no series was not read; that is unknown, never closed.'
            ),
            [f'{{tenant="{r.tenant}",state="{r.state}"}} 1' for r in ordered],
        ),
        (
            'branchleft_support_access_lane',
            "The lane of the open grant, present only while a grant's clock is readable.",
            [f'{{tenant="{r.tenant}",lane="{r.lane}"}} 1' for r in ordered if r.lane is not None],
        ),
        (
            'branchleft_support_access_granted_timestamp_seconds',
            'When the open grant was opened, in Unix seconds.',
            [f'{{tenant="{r.tenant}"}} {seconds(r.granted_ms)}' for r in ordered if r.granted_ms is not None],
        ),
        (
            'branchleft_support_access_deadline_timestamp_seconds',
            'When the open grant closes by itself, in Unix seconds.',
            [f'{{tenant="{r.tenant}"}} {seconds(r.deadline_ms)}' for r in ordered if r.deadline_ms is not None],
        ),
        (
            'branchleft_support_access_observed_timestamp_seconds',
            "The host's time when the report ran, in Unix seconds. A reader treats an old value as unknown.",
            [f'{{tenant="{r.tenant}"}} {seconds(r.observed_ms)}' for r in ordered],
        ),
    ]
    lines: list[str] = []
    for name, help_text, samples in families:
        lines.append(f'# HELP {name} {help_text}')
        lines.append(f'# TYPE {name} gauge')
        lines.extend(f'{name}{sample}' for sample in samples)
    return '\n'.join(lines) + '\n'


def discard(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def write_textfile(cfg: Config, text: str) -> None:
    """Write beside, then rename over, so a reader never sees half a file. Never creates the directory."""
    final = os.path.join(cfg.output_dir, OUTPUT_NAME)
    temporary = f'{final}.tmp-{os.getpid()}-{secrets.token_hex(6)}'
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            os.fchmod(handle.fileno(), 0o644)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, final)
    except OSError:
        discard(temporary)
        discard(final)  # stale series must not outlive a failed refresh
        raise


def publish(cfg: Config, text: str) -> bool:
    try:
        write_textfile(cfg, text)
    except OSError as exc:
        log(f'cannot write the textfile: {type(exc).__name__}')
        return False
    return True


def collect(cfg: Config) -> int:
    try:
        slugs = list_tenants(cfg)
    except ListError as exc:
        log(f'cannot list the tenants: {exc}')
        publish(cfg, render([]))  # nothing is known, so nothing is claimed
        return 1
    readings: list[Reading] = []
    for slug in slugs:
        reading = read_tenant(cfg, slug)
        if reading is None:
            continue  # no series: how the collector learns unknown
        readings.append(reading)
    return 0 if publish(cfg, render(readings)) else 1


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args:
        log('takes no argument')
        return 2
    return collect(Config())


if __name__ == '__main__':
    sys.exit(main())
