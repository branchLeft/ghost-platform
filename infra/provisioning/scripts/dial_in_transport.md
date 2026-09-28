# dial_in_transport.py

## Module overview

The tenant database host "never initiates outward"; the worker on `ops1`
dials in. This module holds:

  - `DialInTransport`, the interface a caller like `pull_encrypt_store.py`
    depends on, so it never has to know which concrete channel it is
    running over;
  - `LocalProcessTransport`, a local test double that runs a producer as an
    ordinary local subprocess. It stands in for a real dial-in call so the
    pipeline's floor-check, single-recipient and never-put-before-exit-0
    properties can be proven against a real local database and a real
    producer without a remote channel;
  - `RemoteMysqldumpTransport`, the real channel: `mysqldump`, run locally
    on the worker's own host, connecting to the tenant database host's
    existing MySQL port over TLS through a host-restricted backup account.
    No new listener anywhere, and the database host gains no new service.

## FORBIDDEN_ENV_PREFIXES

Every prefix that names a storage or encryption credential in this
estate's convention (db/provision/dump_tenant.py's own
FORBIDDEN_ENV_PREFIXES, restated here rather than imported: this module
runs on the org/control side of the trust boundary the producer's own
check exists to enforce, and the two sides proving the same property
independently is the point, not a maintenance burden — a caller-side
check that quietly drifted from the producer's would be exactly the kind
of gap this pipeline exists to close). AWS_* / DB_BACKUP_* for the
storage credential and endpoint, AGE_* for the encryption recipient: the
worker holds all three, and none of them may ever reach the environment a
producer command is invoked with.

## LocalProcessTransport

Runs the producer as an ordinary local subprocess.

This is a TEST DOUBLE, not the production channel — see the module
overview above. It exists so the pipeline's controls can be proven end to
end against a real producer talking to a real local database, without a
network hop to the tenant database host.

Streams line-by-line, mirroring `db/provision/dump_tenant.py`'s own
`run_mysqldump`: a caller watching for a floor-table `INSERT` pattern
needs whole lines, and a chunk boundary that split one across two
`stdout.write()` calls would make that watch unreliable for no reason a
real remote channel would ever force on it.
