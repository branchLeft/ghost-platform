# db/

The shared MySQL 8 host's service layer -- everything that runs on `db1`
once `infra/hosts` has created it and shared-infra's
`RUNBOOK-provision-host.md` has base-provisioned it. No Pulumi here: `db1`
itself is `infra/hosts`' resource, and this directory only ever reaches it
over SSH and Compose, the same boundary `infra/README.md` draws for `app1`.

| Path                                    | What it is                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `stack/`                                 | Copied to `/opt/branchleft/db`; MySQL 8 + mysqld-exporter, run by `branchleft-compose@db.service` |
| `provision/`                             | Tenant DB/user provisioning, the nightly dump and binlog-shipping pipelines, and their unit tests |
| `RUNBOOK-db.md`                          | Deploy steps and the restore drill (both PITR and host-loss scenarios) |

## Why a top-level directory, not `infra/db`

`infra/` in this repo is Pulumi IaC only -- stacks and the one published
component. This is neither: it is service delivery onto an already-created
host, the same shape `shared-infra/hetzner/edge/` is for `edge1`. Putting it
under `infra/` would suggest a Pulumi program lives here when none does;
`db/` sibling to `infra/` names what it actually is and mirrors the pattern
this repo already borrows from shared-infra for `app1`'s eventual stack.
