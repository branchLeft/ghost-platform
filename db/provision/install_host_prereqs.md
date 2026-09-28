# install_host_prereqs.py

## Overview

Idempotent host-prerequisites installer for db1: `age` and a
MySQL-8.0-matched client toolchain (`mysql`, `mysqldump`, `mysqlbinlog`).

Run once by `db/RUNBOOK-db.md` §1, as root, right after `db/provision/` is
copied to the host. Safe to re-run at any time -- every step below first
checks whether its target already exists and does nothing if so, which
matters because a rebuilt db1 runs this again from scratch while a
routinely re-provisioned one should see it complete in a few seconds with
no network access at all.

## Version-pairing constraints

Three version-pairing constraints, each found live during the first db1
bootstrap and worth restating because a plausible-looking alternative for
each one fails a different way:

- Debian trixie's own `default-mysql-client` is MariaDB's client, which
  rejects the MySQL-8-specific flags `dump_nightly.py` passes
  (`--source-data=2`, `--set-gtid-purged`). Oracle's own packages are
  required, not merely preferred.
- `repo.mysql.com`'s **trixie** release declares no `mysql-8.0` component
  (only `mysql-8.4-lts`, `mysql-9.7-lts`, `mysql-innovation`, ...) --
  `dists/trixie/mysql-8.0/` exists on the mirror but is an unlisted stub.
  `mysql-8.0` is only a real component under the repo's **bookworm**
  release, so that is the release this script pins to regardless of the
  host's own Debian version.
- A client one minor ahead of an 8.0 server is not a safe substitute here:
  `mysqldump` 8.4 issues `SHOW BINARY LOG STATUS` unconditionally under
  `--source-data`, which an 8.0 server rejects outright (`ERROR 1064`).
  `mysqlbinlog` from a newer client reading an older server's binlogs is
  fine (proven live), but `mysqldump` is not -- so the client must be
  exact-matched to the server's 8.0 line, not merely compatible with it.

## The libaio1 packaging gap

A fourth, unrelated packaging fact drives part of the rest of this file:
Oracle ships `mysqlbinlog` in `mysql-community-server-core`, not in
`mysql-community-client` -- binaries only, no systemd unit, nothing
enabled or started -- and that package depends on `libaio1`, which trixie
does not carry (`libaio1t64`, trixie's 64-bit-time_t successor, does not
`Provide` the old name). Adding bookworm as a full apt source to pull one
package would need pinning to stop it from also winning dependency
resolution for unrelated trixie packages; fetching the single `.deb` from
the Debian pool and installing it directly avoids that class of problem
entirely, which is also exactly what the live repair did -- but that
`.deb` is fetched over plain HTTP and `dpkg -i`'d as root, so unlike
everything installed through apt (which apt itself verifies against the
archive's signed Release file), nothing verifies it by default.
`LIBAIO1_DEB_SHA256` closes that gap: the filename and hash are pinned
constants rather than discovered by listing the pool directory, both
because Debian pool artifacts are immutable per published version (a hash
pinned today is still correct next year) and because "install whatever the
directory currently lists as newest" is itself an unpinned, unverified
supply chain. To move the pin forward -- only needed if this exact `.deb`
is ever removed from the pool -- fetch the new filename's `.deb` from
`https://deb.debian.org/debian/pool/main/liba/libaio/`, compute its
`sha256sum`, and update `LIBAIO1_DEB_FILENAME` and `LIBAIO1_DEB_SHA256`
together.

## Keyring and pin paths

`MYSQL_APT_KEYRING_PATH` names the same file the initial hand repair on
db1 created (`/usr/share/keyrings/mysql.gpg`) rather than a new name of
this script's own choosing: the block that (re)creates it is gated on the
mysql packages being absent, so a converged host never re-enters it today,
but a future purge-and-rerun that used a different filename would leave two
trust anchors on the host instead of one self-healing one.

`MYSQL_APT_PIN_PATH` holds the mysql-community packages to the 8.0 line via
apt preferences, independent of and in addition to the version check in
`verify()`: db1 runs `unattended-upgrades`, which resolves candidate
versions the same way any other `apt-get install`/`upgrade` does, so
without a pin an upstream 8.4 or newer release reaching the pinned
bookworm `mysql-8.0` component would silently become the candidate on the
next automatic run and break the `mysqldump --source-data` path this whole
script exists to keep working.

## MYSQL_GPG_KEY_FINGERPRINT

The primary "MySQL Release Engineering `<mysql-build@oss.oracle.com>`" key
(`rsa4096/B7B3B788A8D3785C`) -- the one whose `[S]` capability actually
signs `repo.mysql.com`'s Release files, not its `[E]` encryption subkey.
Both `MYSQL_GPG_KEY_URLS` re-export this exact same primary key under
different self-signature expiry dates (`gpg --show-keys --keyid-format
long` on both fetched files reports the identical fingerprint below, just
an earlier expiry on one export versus a later one on the other), which is
why one constant covers both fetches. Cross-checked against the exact same
value Oracle publishes on its own GPG-signature-checking documentation --
their spaced, human-readable rendering matches
`MYSQL_GPG_KEY_FINGERPRINT` below byte for byte once the spaces are
removed. Without this pin, `http_fetch` trusts whatever `repo.mysql.com`
(or anything between here and it) hands back as "the MySQL key" -- a
swapped key would go straight into the keyring `mysql-community.list`
trusts for every package this script `apt-get install`s as root.

## ensure_mysql_gpg_keyring

Builds one keyring from both current signing keys, and re-derives it on
every call to compare against whatever is already on disk -- gating on
bare existence would let a run killed mid-write (or any other corruption)
leave a keyring every later run treats as already done, with nothing to
self-heal it. The write itself is atomic for the same reason: this
function can be interrupted too.

Each fetched file is checked against `MYSQL_GPG_KEY_FINGERPRINT` *before*
any of it is dearmored or written -- a wrong, swapped, or *appended* key at
either URL refuses here, rather than joining a keyring that
`mysql-community.list` then trusts for every `apt-get install` this script
runs as root. The check requires the file's primary keys to be *exactly*
`[MYSQL_GPG_KEY_FINGERPRINT]` -- membership alone (checking only that the
pin is present) would accept the pinned key plus any number of extra,
unpinned primary keys appended to the same armored file, and dearmor the
whole file including those extras into the trusted keyring.

Returns True if the file was created or changed.
