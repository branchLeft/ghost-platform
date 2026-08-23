#!/usr/bin/env python3
"""Idempotent host-prerequisites installer for db1: `age` and a MySQL-8.0-
matched client toolchain (`mysql`, `mysqldump`, `mysqlbinlog`).

Run once by db/RUNBOOK-db.md §1, as root, right after `db/provision/` is
copied to the host. Safe to re-run at any time -- every step below first
checks whether its target already exists and does nothing if so, which
matters because a rebuilt db1 runs this again from scratch while a
routinely re-provisioned one should see it complete in a few seconds with
no network access at all.

Three version-pairing constraints, each found live during the first db1
bootstrap (2026-08-23) and worth restating because a plausible-looking
alternative for each one fails a different way:

* Debian trixie's own `default-mysql-client` is MariaDB's client, which
  rejects the MySQL-8-specific flags `dump_nightly.py` passes
  (`--source-data=2`, `--set-gtid-purged`). Oracle's own packages are
  required, not merely preferred.
* `repo.mysql.com`'s **trixie** release declares no `mysql-8.0` component
  (only `mysql-8.4-lts`, `mysql-9.7-lts`, `mysql-innovation`, ...) --
  `dists/trixie/mysql-8.0/` exists on the mirror but is an unlisted stub.
  `mysql-8.0` is only a real component under the repo's **bookworm**
  release, so that is the release this script pins to regardless of the
  host's own Debian version.
* A client one minor ahead of an 8.0 server is not a safe substitute here:
  `mysqldump` 8.4 issues `SHOW BINARY LOG STATUS` unconditionally under
  `--source-data`, which an 8.0 server rejects outright (`ERROR 1064`).
  `mysqlbinlog` from a newer client reading an older server's binlogs is
  fine (proven live), but `mysqldump` is not -- so the client must be
  exact-matched to the server's 8.0 line, not merely compatible with it.

A fourth, unrelated packaging fact drives the rest of this file: Oracle
ships `mysqlbinlog` in `mysql-community-server-core`, not in
`mysql-community-client` -- binaries only, no systemd unit, nothing enabled
or started -- and that package depends on `libaio1`, which trixie does not
carry (`libaio1t64`, trixie's 64-bit-time_t successor, does not `Provide`
the old name). Adding bookworm as a full apt source to pull one package
would need pinning to stop it from also winning dependency resolution for
unrelated trixie packages; fetching the single `.deb` from the Debian pool
and installing it directly avoids that class of problem entirely, which is
also exactly what the live repair did.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import urllib.request

AGE_PACKAGE = "age"
MYSQL_CLIENT_PACKAGE = "mysql-community-client"
MYSQL_SERVER_CORE_PACKAGE = "mysql-community-server-core"
LIBAIO1_PACKAGE = "libaio1"

# Pinned to bookworm regardless of the host's own release -- see module
# docstring: trixie's mysql-8.0 component does not exist, and the server is
# 8.0, so bookworm's matching client is what this script must install.
MYSQL_APT_RELEASE = "bookworm"
MYSQL_APT_COMPONENT = "mysql-8.0"
MYSQL_APT_REPO_BASE = "http://repo.mysql.com/apt/debian"
MYSQL_APT_LIST_PATH = "/etc/apt/sources.list.d/mysql-community.list"
MYSQL_APT_KEYRING_PATH = "/usr/share/keyrings/mysql-community.gpg"

# Both keys are current on repo.mysql.com; the 2023 key still signs some
# already-published Release files the 2025 key does not cover, so a keyring
# built from only one intermittently fails signature verification.
MYSQL_GPG_KEY_URLS = (
    "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025",
    "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023",
)

LIBAIO1_POOL_URL = "http://deb.debian.org/debian/pool/main/liba/libaio/"
LIBAIO1_DEB_RE = re.compile(r'href="(libaio1_[^"/]+_amd64\.deb)"')

# (binary, expected major.minor) -- both must report exactly this line,
# never a newer one: see the mysqldump/8.4 constraint in the module
# docstring.
VERSION_CHECKS = (("mysqldump", "8.0"), ("mysqlbinlog", "8.0"))
VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")


class HostPrereqError(Exception):
    """A step did not complete; main() reports this and exits non-zero."""


def http_fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as response:  # noqa: S310 -- fixed http(s) hosts, not user input
        return response.read()


def is_installed(package: str, *, run=subprocess.run) -> bool:
    result = run(
        ["dpkg-query", "-W", "-f=${Status}", package],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and "install ok installed" in result.stdout


def apt_get(*args: str, run=subprocess.run) -> None:
    result = run(["apt-get", *args], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise HostPrereqError(f"apt-get {' '.join(args)} exited {result.returncode}: {result.stderr.strip()}")


def ensure_mysql_gpg_keyring(*, keyring_path: str = MYSQL_APT_KEYRING_PATH, run=subprocess.run, fetch=http_fetch) -> None:
    """Builds one keyring from both current signing keys. A no-op once the
    file exists -- repo.mysql.com's keys do not rotate on a schedule this
    script needs to track, and re-fetching on every run would be the only
    network access an otherwise-satisfied re-run makes."""
    if os.path.exists(keyring_path):
        return
    combined_armored = b"".join(fetch(url) for url in MYSQL_GPG_KEY_URLS)
    result = run(
        ["gpg", "--dearmor"],
        input=combined_armored,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr if isinstance(result.stderr, str) else result.stderr.decode(errors="replace")
        raise HostPrereqError(f"gpg --dearmor exited {result.returncode}: {stderr.strip()}")
    stdout = result.stdout if isinstance(result.stdout, bytes) else result.stdout.encode()
    with open(keyring_path, "wb") as handle:
        handle.write(stdout)
    os.chmod(keyring_path, 0o644)


def mysql_apt_source_line(*, keyring_path: str = MYSQL_APT_KEYRING_PATH) -> str:
    return f"deb [signed-by={keyring_path}] {MYSQL_APT_REPO_BASE} {MYSQL_APT_RELEASE} {MYSQL_APT_COMPONENT}\n"


def ensure_mysql_apt_source(
    *, list_path: str = MYSQL_APT_LIST_PATH, keyring_path: str = MYSQL_APT_KEYRING_PATH
) -> bool:
    """Returns True if the source list file was created or changed --
    the caller uses that to decide whether `apt-get update` is needed."""
    content = mysql_apt_source_line(keyring_path=keyring_path)
    if os.path.exists(list_path):
        with open(list_path, encoding="utf-8") as handle:
            if handle.read() == content:
                return False
    with open(list_path, "w", encoding="utf-8") as handle:
        handle.write(content)
    return True


def _deb_version(filename: str) -> str:
    # libaio1_0.3.113-4_amd64.deb -> "0.3.113-4"
    return filename.split("_", 1)[1].rsplit("_", 1)[0]


def pick_newest_deb(filenames: list[str], *, run=subprocess.run) -> str:
    """Debian version strings do not sort correctly as text (`1.10` < `1.9`
    lexically), so the newest is picked with dpkg's own comparator rather
    than a text or tuple sort."""
    if not filenames:
        raise HostPrereqError("no candidate .deb filenames to choose from")
    newest = filenames[0]
    newest_version = _deb_version(newest)
    for candidate in filenames[1:]:
        candidate_version = _deb_version(candidate)
        result = run(
            ["dpkg", "--compare-versions", candidate_version, "gt", newest_version],
            check=False,
        )
        if result.returncode == 0:
            newest = candidate
            newest_version = candidate_version
    return newest


def ensure_libaio1(*, run=subprocess.run, fetch=http_fetch) -> None:
    """`mysql-community-server-core` depends on `libaio1`, which trixie does
    not ship (`libaio1t64` does not `Provide` the old name). Fetches the
    single package straight from the Debian pool rather than adding
    bookworm as a full apt source -- see the module docstring for why a
    whole extra release is worse than one pinned .deb here."""
    if is_installed(LIBAIO1_PACKAGE, run=run):
        return
    listing = fetch(LIBAIO1_POOL_URL).decode("utf-8", errors="replace")
    candidates = LIBAIO1_DEB_RE.findall(listing)
    if not candidates:
        raise HostPrereqError(f"no {LIBAIO1_PACKAGE}_*_amd64.deb found at {LIBAIO1_POOL_URL}")
    chosen = pick_newest_deb(candidates, run=run)
    deb_bytes = fetch(LIBAIO1_POOL_URL + chosen)
    fd, tmp_path = tempfile.mkstemp(suffix=".deb", prefix="libaio1-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(deb_bytes)
        result = run(["dpkg", "-i", tmp_path], capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise HostPrereqError(f"dpkg -i {chosen} exited {result.returncode}: {result.stderr.strip()}")
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def install_package(package: str, *, run=subprocess.run) -> None:
    result = run(
        ["apt-get", "install", "-y", package],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise HostPrereqError(f"apt-get install -y {package} exited {result.returncode}: {result.stderr.strip()}")


def verify(*, run=subprocess.run) -> list[str]:
    """Returns a list of human-readable problems; empty means everything
    this script promises is actually in place."""
    problems: list[str] = []
    if not is_installed(AGE_PACKAGE, run=run):
        problems.append(f"{AGE_PACKAGE} is not installed")
    for binary, expected_minor in VERSION_CHECKS:
        result = run([binary, "--version"], capture_output=True, text=True, check=False)
        if result.returncode != 0:
            problems.append(f"{binary} --version exited {result.returncode}")
            continue
        match = VERSION_RE.search(result.stdout)
        if not match:
            problems.append(f"{binary} --version did not report a parseable version: {result.stdout.strip()!r}")
            continue
        major_minor = f"{match.group(1)}.{match.group(2)}"
        if major_minor != expected_minor:
            problems.append(
                f"{binary} reports {match.group(0)}, expected {expected_minor}.x "
                "(a version-mismatched client against the 8.0 server -- see module docstring)"
            )
    return problems


def ensure_all(
    *,
    run=subprocess.run,
    fetch=http_fetch,
    list_path: str = MYSQL_APT_LIST_PATH,
    keyring_path: str = MYSQL_APT_KEYRING_PATH,
) -> None:
    needs_age = not is_installed(AGE_PACKAGE, run=run)
    needs_mysql_client = not is_installed(MYSQL_CLIENT_PACKAGE, run=run)
    needs_mysql_core = not is_installed(MYSQL_SERVER_CORE_PACKAGE, run=run)

    if not (needs_age or needs_mysql_client or needs_mysql_core):
        # Already the end state a prior run (by hand or by this script)
        # reached -- no apt-get, no network, nothing to do.
        return

    if needs_mysql_client or needs_mysql_core:
        ensure_mysql_gpg_keyring(keyring_path=keyring_path, run=run, fetch=fetch)
        ensure_mysql_apt_source(list_path=list_path, keyring_path=keyring_path)
        ensure_libaio1(run=run, fetch=fetch)

    apt_get("update", run=run)

    if needs_age:
        install_package(AGE_PACKAGE, run=run)
    if needs_mysql_client:
        install_package(MYSQL_CLIENT_PACKAGE, run=run)
    if needs_mysql_core:
        install_package(MYSQL_SERVER_CORE_PACKAGE, run=run)


def main(argv: list[str]) -> int:  # noqa: ARG001 -- no args today, kept for the module's own convention
    if os.geteuid() != 0:
        print("install_host_prereqs: must run as root", file=sys.stderr)
        return 1
    try:
        ensure_all()
        problems = verify()
    except HostPrereqError as exc:
        print(f"install_host_prereqs: {exc}", file=sys.stderr)
        return 1
    if problems:
        for problem in problems:
            print(f"install_host_prereqs: {problem}", file=sys.stderr)
        return 1
    print("install_host_prereqs: age present; mysqldump and mysqlbinlog report 8.0.x")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
