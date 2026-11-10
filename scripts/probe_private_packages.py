#!/usr/bin/env python3
"""Fail if a package that must be private can be read without a credential.

Usage:
    probe_private_packages.py [--images PATH] [--list PATH]

The registry prefix comes from the mirror list (images.json "registry"). The
packages that must stay private, and the control package that must be served,
come from .github/image-mirror/private-packages.json.

For each package the probe asks the registry for an anonymous pull token (the
token request carries no credential and no Authorization header), then lists
the package's tags with that token. A 200 means the package is served to anyone.

Verdicts, fail-closed:
    private package served          -> FAIL
    private package refused         -> pass
    private package unknown answer  -> FAIL (a 5xx, a timeout, a bad token reply)
    control not served              -> FAIL, the probe itself is broken

Exit 0: every private package refused and the control served.
Exit 1: a private package served or unknown, or the control not served.
Exit 2: a list is unreadable or inconsistent with the mirror list.
"""

from __future__ import annotations

import argparse
import http.client
import json
import re
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Protocol
from urllib.parse import urlencode

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IMAGES = REPO_ROOT / ".github" / "image-mirror" / "images.json"
DEFAULT_LIST = REPO_ROOT / ".github" / "image-mirror" / "private-packages.json"

REGISTRY = re.compile(r"\A([a-z0-9.-]+)/([a-z0-9._-]+(?:/[a-z0-9._-]+)*)\Z")
PACKAGE = re.compile(r"\A[a-z0-9]+(?:-[a-z0-9]+)*\Z")
REFUSED_STATUSES = frozenset({401, 403, 404})
TIMEOUT_SECONDS = 30.0


class ProbeListError(Exception):
    """A list file is unreadable or inconsistent. Exit 2."""


class Verdict(Enum):
    SERVED = "served"
    REFUSED = "refused"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Result:
    repo: str
    verdict: Verdict
    detail: str


class Transport(Protocol):
    def get(
        self, host: str, path: str, headers: dict[str, str]
    ) -> tuple[int, bytes]: ...


class HttpsTransport:
    """Stdlib HTTPS GET. Sends only the headers it is given."""

    def get(self, host: str, path: str, headers: dict[str, str]) -> tuple[int, bytes]:
        conn = http.client.HTTPSConnection(host, timeout=TIMEOUT_SECONDS)
        try:
            conn.request("GET", path, headers=headers)
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()


def split_registry(registry: object) -> tuple[str, str]:
    """Return (host, path) from a registry prefix such as host/owner/namespace."""
    if not isinstance(registry, str):
        raise ProbeListError("registry must be a string")
    match = REGISTRY.match(registry)
    if match is None:
        raise ProbeListError(f"registry {registry!r} is not host/owner[/namespace]")
    return match.group(1), match.group(2)


def load_mirror_names(images_path: Path) -> tuple[str, list[str]]:
    """Return the registry prefix and the package names in the mirror list."""
    try:
        data = json.loads(images_path.read_text())
    except (OSError, ValueError) as err:
        raise ProbeListError(f"cannot read {images_path}: {err}") from err
    if not isinstance(data, dict):
        raise ProbeListError(f"{images_path} is not a JSON object")
    images = data.get("images")
    if not isinstance(images, list):
        raise ProbeListError("images must be a list")
    names: list[str] = []
    for i, entry in enumerate(images):
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            raise ProbeListError(f"images[{i}] has no name")
        names.append(entry["name"])
    registry = data.get("registry")
    split_registry(registry)
    assert isinstance(registry, str)
    return registry, names


@dataclass(frozen=True)
class PrivateList:
    mirror: list[str]
    derived: list[str]
    control: str


def load_private_list(list_path: Path) -> PrivateList:
    try:
        data = json.loads(list_path.read_text())
    except (OSError, ValueError) as err:
        raise ProbeListError(f"cannot read {list_path}: {err}") from err
    if not isinstance(data, dict):
        raise ProbeListError(f"{list_path} is not a JSON object")
    mirror = _names(data.get("mirror"), "mirror")
    derived = _names(data.get("derived"), "derived")
    control = data.get("control")
    if not isinstance(control, str) or PACKAGE.match(control) is None:
        raise ProbeListError("control must be one package name")
    everything = mirror + derived
    if len(set(everything)) != len(everything):
        raise ProbeListError("a package name appears more than once")
    if control in everything:
        raise ProbeListError("the control must not be in the private list")
    return PrivateList(mirror=mirror, derived=derived, control=control)


def _names(value: object, key: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ProbeListError(f"{key} must be a non-empty list")
    for name in value:
        if not isinstance(name, str) or PACKAGE.match(name) is None:
            raise ProbeListError(f"{key} entry {name!r} is not a package name")
    return list(value)


def tags_path(repo: str) -> str:
    return f"/v2/{repo}/tags/list"


def read_token(body: bytes) -> str | None:
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    token = data.get("token")
    if isinstance(token, str) and token:
        return token
    return None


def check_package(transport: Transport, host: str, repo: str) -> Result:
    """Ask for an anonymous pull token, then list the package's tags with it."""
    query = urlencode({"service": host, "scope": f"repository:{repo}:pull"})
    try:
        status, body = transport.get(host, "/token?" + query, {})
    except (OSError, http.client.HTTPException) as err:
        return Result(repo, Verdict.UNKNOWN, f"token request failed: {err}")
    if status in REFUSED_STATUSES:
        return Result(repo, Verdict.REFUSED, f"token refused with {status}")
    if status != 200:
        return Result(repo, Verdict.UNKNOWN, f"token answered {status}")
    token = read_token(body)
    if token is None:
        return Result(repo, Verdict.UNKNOWN, "token reply carried no token")
    try:
        status, _ = transport.get(
            host, tags_path(repo), {"Authorization": f"Bearer {token}"}
        )
    except (OSError, http.client.HTTPException) as err:
        return Result(repo, Verdict.UNKNOWN, f"tags request failed: {err}")
    if status == 200:
        return Result(repo, Verdict.SERVED, "tags listed to an anonymous token")
    if status in REFUSED_STATUSES:
        return Result(repo, Verdict.REFUSED, f"tags refused with {status}")
    return Result(repo, Verdict.UNKNOWN, f"tags answered {status}")


def run(images_path: Path, list_path: Path, transport: Transport) -> int:
    try:
        registry, mirror_names = load_mirror_names(images_path)
        private = load_private_list(list_path)
    except ProbeListError as err:
        print(f"PROBE LIST ERROR: {err}", file=sys.stderr)
        return 2
    missing = sorted(set(mirror_names) - set(private.mirror))
    if missing:
        print(
            f"PROBE LIST ERROR: mirror names missing from the private list: {missing}",
            file=sys.stderr,
        )
        return 2

    host, registry_path = split_registry(registry)
    owner = registry_path.split("/", 1)[0]
    control_repo = f"{owner}/{private.control}"
    control = check_package(transport, host, control_repo)
    print(f"CONTROL {control.verdict.value} {control.repo}: {control.detail}")
    if control.verdict is not Verdict.SERVED:
        print("PROBE BROKEN: the public control package is not served anonymously")
        return 1

    repos = [f"{registry_path}/{name}" for name in private.mirror]
    repos += [f"{owner}/{name}" for name in private.derived]
    failed: list[str] = []
    for repo in repos:
        result = check_package(transport, host, repo)
        print(f"{result.verdict.value} {result.repo}: {result.detail}")
        if result.verdict is not Verdict.REFUSED:
            failed.append(repo)
    if failed:
        print(
            f"PRIVATE PROBE FAILED: {len(failed)} package(s) readable or unknown: {failed}"
        )
        return 1
    print(f"PRIVATE PROBE OK: {len(repos)} package(s) refused, control served")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--images", type=Path, default=DEFAULT_IMAGES)
    parser.add_argument("--list", type=Path, default=DEFAULT_LIST)
    args = parser.parse_args(argv)
    return run(args.images, args.list, HttpsTransport())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
