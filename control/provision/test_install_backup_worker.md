# test_install_backup_worker.py

## Module overview

Unit tests for `install_backup_worker.py`. Every `systemctl`, `useradd`,
`id` and `mysqldump` call is faked, and every path lives in a temporary
directory. Ownership checks run against the test process's own uid. No
root, no systemd, and no real host are needed.

Two groups of tests carry most of the weight:

- **Drift between copies.** The environment names the installer requires
  are compared against the `_require_env` calls in `nightly_dump_loop.py`
  and the required copy's variables in `backup_worker.py`. The unit files'
  paths are compared against the installer's own `Paths`, and the metrics
  directory against `backup_worker.DEFAULT_BACKUP_AGE_METRICS_DIR`. Any of
  these can move on its own, and each move would fail only on the host.
- **The timer stays off.** Each missing input on its own keeps
  `systemctl enable` from running, while every other step still happens.
  A bad release changes nothing at all.
