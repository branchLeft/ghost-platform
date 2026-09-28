# test_db_compose_contract.py

## Module overview

What `db/stack/compose.yml` must keep true, and nothing else checks.

`mysqld-exporter` crash-looped on db1 for four days while every existing
test passed. Nothing here started a container, so nothing noticed that
v0.20.0 had dropped `DATA_SOURCE_NAME` and that the variable was being
handed to a binary that discards it. The `:?` guard on it made that worse
rather than better: it refused to start when the variable was *absent*
while tolerating it being completely ineffective, which reads in review
like the value is checked.

These assertions are the cheapest thing that would have failed instead.
They are contracts between this file and things that live outside it --
the exporter's own configuration interface, the systemd unit template in
`branchLeft/shared-infra`, and the renderer beside this test -- so each one
breaks on the change that would otherwise only show up on the host.

`shared-infra`'s `hetzner/provision/test_compose_unit_contract.py` states
the same `--wait` contract for the two stacks it commits, and names this
one in its `CONTRACT_DOES_NOT_REACH` register precisely because it cannot
read it. This is that missing half.

Line-based rather than a YAML parse: this repository's Python checks run
on the standard library alone, and the properties asserted here are all
single-line facts.
