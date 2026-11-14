# Percona Server image

`Dockerfile` builds the image the tenant database host runs: Percona Server for
MySQL 8.0.46-37, the same server and the same entrypoint, with three changes.
`.github/workflows/percona-image.yml` builds it, proves it, pushes it, scans the
pushed digest and signs it only if the scan passed. The engine is not swapped:
the base is the one digest `.github/image-mirror/images.json` lists for 8.0.46-37.

## What changes, and why

| Change | Why |
| --- | --- |
| Operating system packages are updated from the two UBI repositories | The base image carries packages with published fixes. The Percona repositories stay disabled during the update, so the server packages cannot move; the same step checks `percona-server-server` is still at `8.0.46-37.1.el9`. |
| `percona-telemetry-agent` and `percona-mysql-shell` are removed | The agent is a Go program and MySQL Shell bundles a Python tree, and between them they carried the Go and Python findings. The host uses neither. The server package declares the agent as a dependency, so the removal is `rpm -e --nodeps`, and the step checks the server is still installed. |
| `PERCONA_TELEMETRY_DISABLE=1`, and `/call-home.sh` and the supervisor script deleted | With the variable unset the base entrypoint starts the supervisor, which calls out to Percona before the server starts. With it set the entrypoint starts `mysqld --percona_telemetry_disable=1` and never reaches the supervisor. |

Everything else is inherited: `ENTRYPOINT`, `CMD`, `EXPOSE`, `VOLUME`, and
`USER mysql` (restored after the root step).

## The scan and the exemptions

The scan is the shared `image-scan.yml` at the v1.1.0 release, on the pushed
digest. It blocks on any Critical or High finding that no valid exemption
covers, and the threshold cannot be set from this repository.

After the changes the image has no Critical finding and a set of High findings
that have no published fix: MIT Kerberos (`krb5-libs`), Expat, GnuPG, SQLite,
json-glib and the util-linux libraries. Each is an entry in
`/.image-scan-exemptions.json` naming the finding, the package and the image,
with the reason it is not reachable, a grant date and an expiry 30 days later.
CODEOWNERS routes that file to the admin team. An exemption covers a finding
only while it has no fix; the day UBI ships one the gate blocks and the image is
rebuilt, which the `workflow_dispatch` trigger is for. A rebuild is also how the
exemptions are renewed: an expired entry fails the scan.

The reasons rest on what was observed in a running container: the server binary
and its default-loaded plugins map none of the libraries, only optional plugins
(LDAP, Kerberos client, group replication, keyring vault) link `libkrb5`, no KDC
or `kadmind` is installed, no `sqlite3` tool is installed, and the image has no
`/etc/fstab`. `smoke_check.py` re-checks the first of those on every build.

## Proving it

`python3 smoke_check.py IMAGE` starts one throwaway container, waits for the
server on port 3306, and checks:

- the server reports 8.0.46-37;
- `percona_telemetry_disable` is `ON` and PID 1 is `mysqld --percona_telemetry_disable=1`;
- the telemetry agent and MySQL Shell packages, `/call-home.sh` and the
  supervisor script are gone;
- none of the libraries behind the exemptions is mapped into the running server.

It does not prove replication, the GTID dump path or a data directory from an
older server: those are the database host's own proofs.

## Raising the version

Change the digest in `Dockerfile` to the new image in `images.json` (add it there
first, so the mirror holds it), change the version in the two checks in the
`RUN` step and in `smoke_check.py`, and re-derive the exemptions from a scan of
the new image. Do not widen an exemption to cover a finding that has a fix.

## Local build

```sh
docker build -f db/percona/Dockerfile -t percona-server:local db/percona
python3 db/percona/smoke_check.py percona-server:local
```

With `IMAGE_REGISTRY` unset the base is pulled from Docker Hub by digest. The
workflow sets it to the private mirror; the bytes are the same.
