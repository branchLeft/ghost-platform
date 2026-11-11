# test_render_tenant_secrets.py

## Coverage rationale

This script is the only place a tenant's credentials become a file, so the
properties the story asks for are asserted here rather than left to a live
host: the file is a regular file, mode `0600`, owned `root:root`; a rerun is a
no-op; every refusal in `render_tenant_secrets.md` is a case; and no sentinel
value appears on stdout or stderr in any of them, success or refusal.

Ownership is asserted two ways. The suite runs as an ordinary user, so
`fchown` is injected and the test checks it was called with `0, 0`. When the
suite is run as root, `stat` is checked for uid and gid `0` as well.

A refused or failed write must leave nothing: the failed-chown and failed-sync
cases list the directory afterwards and expect it empty, which is the temp
file check.

## Control cases

`Sabotage` runs a copy of the script with the mode set to `0644`, and another
with the `fchown` removed, through the same `assert_secure_file` the real
script passes. Each must fail it, so the green cases above are not an all-clear
with no way to go red. The same mutation made by hand to the real script
(`FILE_MODE = 0o644`) turns the mode, rerun and sabotage cases red.
