# test_runbook_no_env_sourcing.py

## Module overview

No RUNBOOK-\*.md may instruct sourcing an `.env` file with bash.

`db.env` (and every sibling `*.env` file this estate hand-writes) is meant to
be *read*, never *evaluated*. A syntax error partway through -- an unquoted
`(` in a DSN was the real incident -- makes bash echo the offending line back
to the terminal, credential included, and sourcing then carries on with the
remaining variables set: the failure is silent except for the one part that
matters.

The fix is a command *shape*, not a one-off edit: `sed -n 's/^VAR=//p'` for a
single value, or `systemd-run --property=EnvironmentFile=` when a script
needs the whole environment -- both parse `KEY=value` pairs without ever
handing the file to a shell. This test asserts the shape stays out of every
runbook in this repo, the same technique
`shared-infra/hetzner/provision/test_runbook_rsync_commands.py` uses for its
own command-shape guard.
