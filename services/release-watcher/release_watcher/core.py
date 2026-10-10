"""Pure decision logic for the Ghost release watcher. No network, no git."""

import re
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Tuple

Version = Tuple[int, int, int]

# ASCII digits only, bounded length. fullmatch, so no trailing newline passes.
STABLE_ALPINE = re.compile(r"([0-9]{1,3})\.([0-9]{1,4})\.([0-9]{1,4})-alpine")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")

# Every FROM instruction, whatever its case, indentation or suffix. Counting
# these (not the strictly-shaped ones) is what stops a second stage hiding.
FROM_INSTRUCTION = re.compile(r"^[ \t]*FROM[ \t]", re.IGNORECASE | re.MULTILINE)

PINNED_FROM = re.compile(
    r"^FROM ghost:([0-9]{1,3}\.[0-9]{1,4}\.[0-9]{1,4})-alpine@(sha256:[0-9a-f]{64})[ \t]*$",
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
    match = STABLE_ALPINE.fullmatch(tag)
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


def _single_pin_match(dockerfile_text: str):
    instructions = FROM_INSTRUCTION.findall(dockerfile_text)
    if len(instructions) != 1:
        raise ValueError(
            f"expected exactly one FROM instruction, found {len(instructions)}; "
            "multi-stage or unusual Dockerfiles are refused"
        )
    matches = PINNED_FROM.findall(dockerfile_text)
    if len(matches) != 1:
        raise ValueError("the one FROM line is not ghost:<x.y.z>-alpine@sha256:<digest>")
    return matches[0]


def read_pin(dockerfile_text: str) -> Pin:
    tag_version, digest = _single_pin_match(dockerfile_text)
    tag = f"{tag_version}-alpine"
    return Pin(tag=tag, digest=digest, version=parse_version(tag))


def apply_pin(dockerfile_text: str, tag: str, digest: str) -> str:
    """Rewrite only the FROM line. Anything else in the file is untouched."""
    if parse_version(tag) is None:
        raise ValueError(f"refusing to write a non-stable tag: {tag!r}")
    if DIGEST.fullmatch(digest) is None:
        raise ValueError(f"refusing to write a malformed digest: {digest!r}")
    _single_pin_match(dockerfile_text)
    replacement = f"FROM ghost:{tag[: -len('-alpine')]}-alpine@{digest}"
    return PINNED_FROM.sub(lambda _match: replacement, dockerfile_text, count=1)


def without_from_line(dockerfile_text: str) -> str:
    """Everything except the FROM line, so a branch can be checked against main."""
    return PINNED_FROM.sub("FROM <pin>", dockerfile_text)


def decide(
    pin: Pin,
    tags,
    resolve_digest: Callable[[str], str],
) -> Decision:
    versions = stable_versions(tags)
    if not versions:
        raise ValueError("registry returned no stable Alpine tags")

    pinned_major = pin.version[0]
    newest_major = max(version[0] for version in versions.values())
    notify = newest_major if newest_major > pinned_major else None

    # The gate set only ever moves within the pinned major line. A newer
    # major is noticed, never followed.
    line = {tag: v for tag, v in versions.items() if v[0] == pinned_major}
    newest_tag = max(line, key=lambda tag: line[tag])
    if line[newest_tag] < pin.version:
        return Decision(notify, None, None, "pinned tag is newer than the registry line")

    digest = resolve_digest(newest_tag)
    if DIGEST.fullmatch(digest) is None:
        raise ValueError(f"registry returned a malformed digest for {newest_tag}: {digest!r}")
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
