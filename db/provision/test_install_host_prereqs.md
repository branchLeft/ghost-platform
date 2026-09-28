# test_install_host_prereqs.py

## Module overview

Unit tests for `install_host_prereqs.py`.

Every external command and network fetch is faked -- no real apt, dpkg,
gpg or HTTP call -- so these assert the constraints found live during
db1's first bootstrap, plus three properties added after a follow-up
review of this exact script: `libaio1` is only ever `dpkg -i`'d when its
fetched bytes match a hash pinned in the module, the GPG keyring write is
atomic and self-healing from a corrupt or truncated file rather than
merely gated on existence, and the mysql-community apt pin is written
even for an already-converged host. Also still covered: bookworm (never
trixie) is the pinned release, both signing keys go into one keyring,
mysqldump/mysqlbinlog must report exactly 8.0.x, and a fully-satisfied
host makes no apt-get, dpkg, gpg or network call at all.
