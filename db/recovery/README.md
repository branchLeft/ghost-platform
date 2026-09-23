# Recovery image

A pinned container carrying the same `age` + MySQL-8.0-matched client
toolchain (`mysql`, `mysqldump`, `mysqlbinlog`) that `db/RUNBOOK-db.md` §1
installs onto `db1` itself. It exists because recovery does not run on the
tenant database host — in the scenario it matters most (the host is gone),
a fresh machine has none of that toolchain and would otherwise be assembled
under incident conditions, against a Debian release that actively fights the
installation. See `ghost-platform-docs/19-try-it-now-design/09-backup-and-recovery.html`
§05 (R5) for the full reasoning.

## Build

Always with `--platform linux/amd64`, whatever the build machine's own
architecture — see the Dockerfile's own comment for why an unpinned build on
an arm64 machine is the wrong kind of "works here".

```bash
docker build --platform linux/amd64 -f db/recovery/Dockerfile -t branchleft-recovery:ci .
```

`db/provision/install_host_prereqs.py` is copied in and run as part of the
build (not re-implemented here), so the image and the host it recovers for
are converged by the same script rather than two independently-maintained
package lists. The script's own `verify()` step runs inside the same `RUN`,
so a base-image or upstream-package change that breaks the version match
fails the build, not a later check.

## Verify the toolchain still matches the server

```bash
python3 db/recovery/check_toolchain_version.py --recovery-image branchleft-recovery:ci
```

Reads the server's pin live out of `db/RUNBOOK-db.md` (the
`branchleft-deploy db mysql:...@sha256:...` command, not a second copy of
the digest) and fails if `mysql`, `mysqldump` or `mysqlbinlog` inside the
image do not report the same major.minor line. `--server-image` overrides
the runbook read; the only reason to use it is to force a known-mismatched
comparison, which is how the control case in the PR that added this file
was produced.

## What is proven, and where

`db/recovery/test_check_toolchain_version.py` covers the parsing and
comparison logic with every `docker run` faked. It does not, by itself,
prove the built image's client tools actually restore anything — a
functional dump/restore/binlog-replay proof against real MySQL 8.0
containers, plus the mismatched-client control case (an 8.4 `mysqldump`
genuinely failing `--source-data=2` against an 8.0 server, reproducing
`install_host_prereqs.py`'s own module docstring), was run by hand and is
recorded verbatim in the PR body for branchLeft/workspace#1205 rather than
kept here — it needs two throwaway MySQL containers and does not belong in
CI's fast, mocked test path.

## Not done here

No CI workflow in this repo pushes this image anywhere. `db/recovery/`'s own
workflow builds and verifies it on every PR and push to `main`, nothing
more — there is no `.claude/delivery-paths.json` row yet saying where a
recovery host would pull it from.
