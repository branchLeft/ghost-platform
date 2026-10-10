"""Pure decision logic for the Ghost release watcher. No network, no git."""

import re
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Tuple

Version = Tuple[int, int, int]

# Stable Alpine tags only. Rejects -next-alpine, -alpine3.23 variants, rc and
# alpha tags, and bare major or minor tags, so a pre-release is never chosen.
STABLE_ALPINE = re.compile(r"^(\d+)\.(\d+)\.(\d+)-alpine$")

FROM_LINE = re.compile(
    r"^FROM ghost:(\d+\.\d+\.\d+)-alpine@(sha256:[0-9a-f]{64})[ \t]*$",
    re.MULTILINE,
)


@dataclass(frozen=True)
class Pin:
    tag: str
    digest: str
    version: Version


@dataclass(frozen=True)
class Decision:
    notify_major: Optional[int]
    pr_tag: Optional[str]
    pr_digest: Optional[str]
    reason: str


def parse_version(tag: str) -> Optional[Version]:
    match = STABLE_ALPINE.match(tag)
    if match is None:
        return None
    major, minor, patch = (int(part) for part in match.groups())
    return (major, minor, patch)


def stable_versions(tags) -> Dict[str, Version]:
    found = {}
    for tag in tags:
        version = parse_version(tag)
        if version is not None:
            found[tag] = version
    return found


def read_pin(dockerfile_text: str) -> Pin:
    matches = FROM_LINE.findall(dockerfile_text)
    if len(matches) != 1:
        raise ValueError(
            "expected exactly one FROM ghost:<x.y.z>-alpine@sha256:<digest> line, "
            f"found {len(matches)}"
        )
    tag_version, digest = matches[0]
    tag = f"{tag_version}-alpine"
    return Pin(tag=tag, digest=digest, version=parse_version(tag))


def apply_pin(dockerfile_text: str, tag: str, digest: str) -> str:
    """Rewrite only the FROM line. Anything else in the file is untouched."""
    if len(FROM_LINE.findall(dockerfile_text)) != 1:
        raise ValueError("cannot rewrite: not exactly one FROM ghost line")
    replacement = f"FROM ghost:{tag[: -len('-alpine')]}-alpine@{digest}"
    return FROM_LINE.sub(lambda _match: replacement, dockerfile_text, count=1)


def decide(
    pin: Pin,
    tags,
    resolve_digest: Callable[[str], str],
    last_noticed_major: Optional[int],
) -> Decision:
    versions = stable_versions(tags)
    if not versions:
        raise ValueError("registry returned no stable Alpine tags")

    pinned_major = pin.version[0]
    newest_major = max(version[0] for version in versions.values())

    notify = None
    if newest_major > pinned_major and (
        last_noticed_major is None or newest_major > last_noticed_major
    ):
        notify = newest_major

    # The gate set only ever moves within the pinned major line. A newer
    # major is noticed, never followed.
    line = {tag: v for tag, v in versions.items() if v[0] == pinned_major}
    newest_tag = max(line, key=lambda tag: line[tag])
    if line[newest_tag] < pin.version:
        return Decision(notify, None, None, "pinned tag is newer than the registry line")

    digest = resolve_digest(newest_tag)
    if newest_tag == pin.tag and digest == pin.digest:
        return Decision(notify, None, None, "pin matches the newest registry digest")
    return Decision(notify, newest_tag, digest, "pin is behind the registry line")


def render_age_metric(last_success_epoch: float) -> str:
    return (
        "# HELP ghost_release_watcher_last_success_timestamp_seconds "
        "Unix time of the last successful poll of the Ghost registry.\n"
        "# TYPE ghost_release_watcher_last_success_timestamp_seconds gauge\n"
        f"ghost_release_watcher_last_success_timestamp_seconds {int(last_success_epoch)}\n"
    )
