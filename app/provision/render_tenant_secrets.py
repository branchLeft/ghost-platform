#!/usr/bin/env python3
"""Render one tenant's secrets file on the app host, from values on stdin.

The tenant stack holds no secret value. Its `secretsEnvTemplate` output names
the keys; this script fills them and writes `/etc/branchleft/<slug>.env`,
root-owned, mode 0600. See render_tenant_secrets.md for the usage and the
contract the controller calls.

Exit 0 on success, 1 on any refusal or failure, 2 on usage error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys

from provision_tenant_volume import ProvisionError, validate_slug

DEFAULT_ETC_DIR = "/etc/branchleft"
FILE_MODE = 0o600
OWNER_UID = 0
OWNER_GID = 0
OWNER_EMAIL_KEY = "GHOST_OWNER_EMAIL"
MAX_STDIN_BYTES = 64 * 1024

TEMPLATE_KEY_LINE = re.compile(r"\A([A-Z][A-Z0-9_]*)=\Z")
# A newline in an EnvironmentFile value adds a variable rather than breaking
# one, so any control character is refused.
CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def secrets_path(slug: str, etc_dir: str = DEFAULT_ETC_DIR) -> str:
    return os.path.join(etc_dir, f"{slug}.env")


def template_keys(template: str) -> list[str]:
    """The `KEY=` lines of the render core's template, in order.

    Refuses any other line that is not a comment: a template that carries a
    value is not the template this script exists to fill.
    """
    keys: list[str] = []
    for line in template.split("\n"):
        if line == "" or line.startswith("#"):
            continue
        match = TEMPLATE_KEY_LINE.match(line)
        if match is None:
            raise ProvisionError(
                "the template has a line that is neither a comment nor an empty KEY= line"
            )
        keys.append(match.group(1))
    if len(set(keys)) != len(keys):
        raise ProvisionError("the template names a key more than once")
    return keys


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    out: dict[str, object] = {}
    for key, value in pairs:
        if key in out:
            raise ProvisionError(f"stdin names the key {key} more than once")
        out[key] = value
    return out


def parse_values(raw: str) -> dict[str, str]:
    """Parse the JSON object of KEY to value. Nothing from `raw` is echoed."""
    try:
        parsed = json.loads(raw, object_pairs_hook=_no_duplicate_keys)
    except ValueError as error:
        if isinstance(error, ProvisionError):
            raise
        raise ProvisionError("stdin is not valid JSON") from None
    if not isinstance(parsed, dict):
        raise ProvisionError("stdin must be a JSON object of KEY to value")
    for key, value in parsed.items():
        if not isinstance(value, str):
            raise ProvisionError(f"the value for {key} is not a string")
    return parsed  # type: ignore[return-value]


def check_values(keys: list[str], values: dict[str, str]) -> None:
    """Refuse a missing key, an extra key, an empty value, a control character,
    and an owner address with whitespace or no '@'. Names keys, never values."""
    missing = [key for key in keys if key not in values]
    if missing:
        raise ProvisionError(f"no value supplied for: {', '.join(missing)}")
    extra = sorted(key for key in values if key not in keys)
    if extra:
        raise ProvisionError(
            f"values supplied for keys the template does not name: {', '.join(extra)}"
        )
    for key in keys:
        value = values[key]
        if value == "":
            raise ProvisionError(f"the value for {key} is empty")
        if CONTROL_CHARACTER.search(value):
            raise ProvisionError(f"the value for {key} contains a control character")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise ProvisionError(f"the value for {key} is not valid UTF-8 text") from None
    if OWNER_EMAIL_KEY in values:
        owner = values[OWNER_EMAIL_KEY]
        if re.search(r"\s", owner) or "@" not in owner:
            raise ProvisionError(f"{OWNER_EMAIL_KEY} is not a valid email address (value withheld)")


def fill_template(template: str, values: dict[str, str]) -> str:
    """Fill each `KEY=` line and leave every other line as rendered."""
    lines = []
    for line in template.split("\n"):
        match = TEMPLATE_KEY_LINE.match(line)
        lines.append(f"{match.group(1)}={values[match.group(1)]}" if match else line)
    return "\n".join(lines)


def _fsync_directory(path: str) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_existing(path: str) -> str | None:
    """The existing file's text, or None when there is none. A symlink or a
    non-regular file is refused. An identical file is brought to the
    required owner and mode through its own descriptor."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ProvisionError(f"{path} exists and cannot be opened safely ({error.strerror})") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ProvisionError(f"{path} exists and is not a regular file")
        with os.fdopen(os.dup(fd), encoding="utf-8", errors="replace") as handle:
            return handle.read()
    finally:
        os.close(fd)


def write_secrets_file(
    slug: str,
    content: str,
    *,
    etc_dir: str = DEFAULT_ETC_DIR,
    fchown=os.fchown,
    fchmod=os.fchmod,
) -> str:
    """Write the file atomically. Returns 'written' or 'unchanged'.

    The temp file is created exclusively, mode 0600, never following a link,
    and is owned and synced before it is linked into place, so the final
    path never holds a partial file or a wider mode.
    """
    target = secrets_path(slug, etc_dir)
    os.makedirs(etc_dir, exist_ok=True)

    existing = _read_existing(target)
    if existing is not None:
        if existing != content:
            raise ProvisionError(
                f"{target} already exists with different content. This script does not "
                "overwrite a secrets file; rotation is a separate step."
            )
        _assert_owner_and_mode(target, fchown=fchown, fchmod=fchmod)
        return "unchanged"

    fd, temp = _exclusive_temp(etc_dir, slug)
    try:
        try:
            fchown(fd, OWNER_UID, OWNER_GID)
            fchmod(fd, FILE_MODE)
            _write_all(fd, content.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        # A hard link, not a rename: it never replaces a file that appeared
        # since the check above, and it fails on a symlink at the target.
        try:
            os.link(temp, target)
        except FileExistsError:
            raise ProvisionError(f"{target} appeared while it was being written; refused") from None
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass
    _fsync_directory(etc_dir)
    return "written"


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view) :]


def _exclusive_temp(etc_dir: str, slug: str) -> tuple[int, str]:
    """A fresh 0600 file in etc_dir, created with O_EXCL and O_NOFOLLOW."""
    for _ in range(100):
        name = f".{slug}.env.{os.urandom(6).hex()}.tmp"
        path = os.path.join(etc_dir, name)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, FILE_MODE)
        except FileExistsError:
            continue
        return fd, path
    raise ProvisionError(f"could not create a temporary file in {etc_dir}")


def _assert_owner_and_mode(path: str, *, fchown, fchmod) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fchown(fd, OWNER_UID, OWNER_GID)
        fchmod(fd, FILE_MODE)
    finally:
        os.close(fd)


def render_tenant_secrets(
    slug: str,
    template: str,
    raw_values: str,
    *,
    etc_dir: str = DEFAULT_ETC_DIR,
    fchown=os.fchown,
    fchmod=os.fchmod,
) -> tuple[str, list[str]]:
    """Validate everything, then write. Returns (outcome, key names)."""
    validate_slug(slug)
    keys = template_keys(template)
    values = parse_values(raw_values)
    check_values(keys, values)
    content = fill_template(template, values)
    outcome = write_secrets_file(slug, content, etc_dir=etc_dir, fchown=fchown, fchmod=fchmod)
    return outcome, keys


def main(
    argv: list[str],
    *,
    geteuid=os.geteuid,
    stdin=None,
    fchown=os.fchown,
    fchmod=os.fchmod,
    out=None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--slug", required=True)
    parser.add_argument("--template-file", required=True)
    parser.add_argument("--etc-dir", default=DEFAULT_ETC_DIR)
    args = parser.parse_args(argv)
    emit = out or (lambda line: print(line))
    stream = stdin if stdin is not None else sys.stdin

    if geteuid() != 0:
        print("render_tenant_secrets: must run as root.", file=sys.stderr)
        return 1
    if stream.isatty():
        print(
            "render_tenant_secrets: the values are read from stdin as a JSON object; "
            "pipe them in, never pass them as arguments.",
            file=sys.stderr,
        )
        return 2

    try:
        with open(args.template_file, encoding="utf-8") as handle:
            template = handle.read()
        raw_values = stream.read(MAX_STDIN_BYTES + 1)
        if len(raw_values) > MAX_STDIN_BYTES:
            raise ProvisionError(f"stdin is larger than {MAX_STDIN_BYTES} bytes")
        outcome, keys = render_tenant_secrets(
            args.slug,
            template,
            raw_values,
            etc_dir=args.etc_dir,
            fchown=fchown,
            fchmod=fchmod,
        )
    except OSError as error:
        where = f"{error.filename}: " if error.filename else ""
        print(f"render_tenant_secrets: {where}{error.strerror or 'I/O error'}", file=sys.stderr)
        return 1
    except ProvisionError as exc:
        print(f"render_tenant_secrets: {exc}", file=sys.stderr)
        return 1

    emit(f"{outcome} {secrets_path(args.slug, args.etc_dir)} mode {oct(FILE_MODE)} owner {OWNER_UID}:{OWNER_GID}")
    for key in keys:
        emit(f"key {key}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
