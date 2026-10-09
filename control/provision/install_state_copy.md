# install_state_copy.py

Installs the state-copy service and timer from the backup worker's staged
release, then enables the timer only when `/etc/branchleft/state-copy.env`
exists, is root-owned 0600 and sets all 16 names, and `age` is installed.
While anything is missing the timer is disabled. `--check` reports and
changes nothing. The service runs as `backup-worker` with the credential
loaded by systemd rather than placed in the environment.
