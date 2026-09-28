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
comparison, which is how the control case for this check is produced.

A mismatched recovery image is worse than an obviously missing one:
`mysqldump --source-data=2` from an 8.4 client issues `SHOW BINARY LOG
STATUS` unconditionally, which an 8.0 server rejects outright — so the
failure would otherwise surface only when the image is actually needed,
under incident conditions, against a server that cannot be changed to
suit it. This check moves that failure to build time instead.

The pin lives only in `db/RUNBOOK-db.md`, never duplicated as a constant
here: that runbook carries the one command that actually re-pins `db1`,
and a second copy of the digest in this script would be exactly the kind
of drift this design otherwise guards against — two things meant to
agree, checked against each other only by both having been edited
correctly. The runbook carries that command twice (the always-fails
bootstrap run and the re-pin that follows it), and both are meant to name
the same image, so the reader matches every occurrence rather than just
the first, and refuses to pick a winner when they disagree.

This compares against the runbook's pin, not against what `db1` itself
currently reports running — there is no way to read
`/etc/branchleft/db.image.env` back from CI. A green run here is evidence
the runbook is internally consistent, not evidence it matches what `db1`
is currently running; `db/RUNBOOK-db.md` carries the step that closes
that gap by hand.

The comparison is major.minor, not the full patch version, matching
`install_host_prereqs.py`'s own `verify()` and design 09's own language:
exact-matched to the server's line, not merely compatible with it.

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

## Publishing

`.github/workflows/recovery-image.yml`'s `push` job publishes this image to
`ghcr.io/branchleft/db-recovery` on every push to `main` that touches
`db/recovery/**`, `db/provision/install_host_prereqs.py`,
`db/RUNBOOK-db.md` or the workflow file itself — tagged with the git SHA
and `latest`, same shape as `registry-push.yml`'s tenant image push. `main`
being protected by required review is the whole of the gate: a publish only
ever follows a reviewed and approved merge, and there is deliberately no
`workflow_dispatch` trigger to bypass that. The same workflow also runs on
a weekly schedule (build-and-verify only, no publish) so upstream drift —
`repo.mysql.com`'s apt index, the MySQL signing key, a Debian trixie
package change — is caught even when nothing here changes.

`db/RUNBOOK-db.md` records the published image **by digest**, not by tag —
see its own instructions for exactly how, and for why that field cannot be
filled in until the workflow has actually run once. A recovery drill or
incident pulls that digest, never `latest`: `latest` can move at any
merge, and recovery under incident conditions must pull the exact,
already-verified image the runbook names, not whatever happens to be newest.

There is no `.claude/delivery-paths.json` row for `db/recovery/**` in this
repo — that file lives in `branchLeft/workspace`, tracked there.

## Restoring a tenant onto a drained colour

`restore_drained.py` is the ordered chain a real restore drill or incident
runs against a colour that has already been brought up drained (LLD-2's
broker owns the flag; this script never sets it, only ever clears it, and
only as the last thing it does on success): MySQL readiness on the
recovery target, importing the dump, asserting a named, tenant-specific
string renders on the colour's own homepage, and only then clearing the
flag. A failure at any stage leaves the flag alone, so a restore that
turns out wrong is discarded by staying drained rather than by undoing an
undrain that already happened.

`verify_tenant_content` never reads an HTTP `200` as success by itself —
see `09-backup-and-recovery.html` §04 (R4) for why: a Ghost pointed at a
schema with no data still boots its own migrations and answers `200`, so
an empty restore has to fail the content check for as long as it is asked,
not merely until Ghost finishes booting.

**`restore_only` also refuses before importing anything if the recovery
target already holds a non-system database.** A per-tenant dump's own
`CREATE DATABASE IF NOT EXISTS`/`USE` statements restore INTO whatever
database of that name already exists, not beside it — so a target that
already has one is corrupted by import, never merely at risk of it. The
check is an emptiness check, not a name match against the tenant being
restored, and there is no flag to bypass it.

Two modes exist because a real orchestrator has to start the colour's own
Ghost process in between importing the dump and checking it — Ghost has to
exist against the now-restored (or, in the control case, deliberately
empty) database before anything can be asked of it over HTTP:

```bash
python3 db/recovery/restore_drained.py --mode restore-only \
  --dump tenant.sql --host <recovery-target> --user root
# ... start that colour's Ghost process against the now-restored database ...
python3 db/recovery/restore_drained.py --mode verify-and-undrain \
  --base-url http://<colour>/ --expect "<a known post's own body>" \
  --flag-path <the drain flag this colour already carries>
```

`--mode full` (the default) composes both halves — the ordered chain
design 09 07c names — for a target that already has a Ghost process
running against it. `RESTORE_MYSQL_PWD` carries the recovery target's
password; nothing here accepts, reads or forwards any other credential.

The live-database refusal (`assert_target_has_no_live_database`) runs
between readiness and the import, not merely before `restore_only`
returns: it needs a live connection to list what the target already has,
and it must complete before `restore_dump` gets anywhere near the target.

## What the drained-restore unit tests prove

`test_restore_drained.py` fakes every external effect — no real `mysql`
client, no real HTTP call, no real sleep — and proves the ordering
guarantee (readiness, restore, verify, undrain-last) plus the design's
control case in isolation: a `200` with no expected content must never be
read as success, and must be reported differently from "never answered at
all". `run_drained_restore`'s ordering guarantee — the flag is only ever
cleared after every earlier stage has passed — is proven for each stage by
sabotaging that one stage's fake and checking the flag-clear fake was
never called.

## Running the real-container proof

```bash
./db/recovery/test-restore-drained-proof.sh <ghost-platform-image> <drain-sidecar-dist-dir>
```

Run from the repo root, or let the script `cd` there itself.
`<drain-sidecar-dist-dir>` is `services/drain-sidecar`'s own directory,
built first (`npm run build` there). The script mounts its `dist/`,
`node_modules/` and `package.json` into a plain `node:26.5.0-bookworm-slim`
container rather than building `services/drain-sidecar/Dockerfile` itself,
because that Dockerfile's own `npm ci` needs a GitHub Packages read token
this proof does not assume is available — the sidecar code under test is
identical either way.

Five containers: two real MySQL 8.0 servers standing in for the tenant
database host and a fresh recovery target, this directory's own recovery
image (by digest, never `latest`), this repo's own platform image serving
each colour, and the real `services/drain-sidecar` code answering each
colour's health port.

**GREEN:** a real Ghost creates a real owner and a real, named post against
a source database; that tenant's dump is taken with the same `mysqldump`
flags `dump_tenant.py` itself uses; `restore_drained.py` restores it onto a
fresh target that a second Ghost then boots against, already drained; the
named post's body is read back from the rendered homepage; only then is
the flag cleared, and the sidecar is checked before and after.

**CONTROL:** the same chain, with an empty file in place of a real dump.
The target Ghost boots its own migrations against nothing and answers
`200` — and `restore_drained.py`'s content check must refuse that, leaving
the colour drained.

**LIVE-COLLISION:** a fourth MySQL server already holds a live
`ghost_tenant1` with known rows, seeded before `restore_drained.py` ever
runs. `--mode restore-only` must refuse before importing anything, and the
live database's own row count and `CHECKSUM TABLE` value must be provably
unchanged afterwards: restoring a per-tenant dump (its own `CREATE
DATABASE IF NOT EXISTS`/`USE`) onto a host that already has that database
restores INTO it, not beside it, so a target that already holds one must
never be imported into at all.

Local-sandbox simplification, stated rather than left implicit: `mysqldump`
runs over TCP as root here, standing in for `dump_tenant.py`'s own unix
socket and dedicated `backup`@`localhost` account (proven separately, and
unit-tested, by `db/provision/test_dump_tenant.py`) — this proof's job is
the restore-onto-a-drained-colour chain, not a second proof of the dump
script's own connection boundary.
