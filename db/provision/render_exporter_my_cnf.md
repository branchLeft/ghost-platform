# render_exporter_my_cnf.py

## Module overview

Writes the mysqld-exporter's `.my.cnf` from `EXPORTER_MYSQL_PWD` in
`/etc/branchleft/db.env`.

The exporter has no way to take a password that is not either a file it
reads or an environment variable. An environment variable is visible in
`docker inspect` to every account that can reach the Docker socket, so this
renders a file instead, mode 0400 and owned by the uid the container runs
as.

The output lives under `/etc/branchleft` rather than in the stack
directory, because it has to exist before `docker compose up` runs and
`/opt/branchleft/db` is a deploy target that is re-copied wholesale.
`/etc/branchleft` is where every other stack secret on this estate already
lives, and nothing sweeps it.

Run again after a password rotation, then restart `branchleft-compose@db`
to pick it up. The stack's systemd drop-in also runs this once before every
start, so a fresh boot never serves a stale render.

## SAFE_PASSWORD

The exporter runs `os.ExpandEnv` over every value it parses out of this
file (config.go's `cfg.ValueMapper`), so a password containing `$` is
silently rewritten before it is used: `pw$with$dollars` authenticates as
`pw`, the container stays up and serving, and only `mysql_up 0` says
otherwise. The same parser strips a leading and trailing `"` and treats
`#`, `;` and `\` as syntax.

Allow-listed rather than escaped, because none of those has an escape that
survives both the ini parser and the variable expansion -- `$$` expands to
the empty string, it does not quote. A generated password has no reason to
leave this alphabet, so the constraint costs nothing and cannot be got
subtly wrong. 20 characters is the floor for an account reachable only over
a host-local socket.

## clear_bind_mount_stub

Removes a directory or symlink sitting where the rendered file goes.

Docker creates an empty *directory* at a bind-mount source it cannot find.
So a single `docker compose up` run before this renderer was installed --
or on a host where the drop-in did not land -- leaves a directory at the
output path, and `os.replace` then fails with `IsADirectoryError` on every
subsequent start, MySQL's included, permanently and across reboots.

An empty directory is that stub and is removed. A non-empty one is
somebody's data and `os.rmdir` refuses it, which is the right way round.
