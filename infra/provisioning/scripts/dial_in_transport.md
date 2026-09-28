# dial_in_transport.py

## Module overview

The estate's own design record is explicit that the direction is fixed: the
tenant host "never initiates outward" and the worker "dials in over the
collector's channel — one transport [reused]". The channel already has one
concrete shape today — `services/mailgun-shim`'s bearer-token-authenticated
`GET /drain`, dialled by the mail collector — but that collector's own
production implementation is still being built elsewhere in this estate,
and this repository has no equivalent dial-in server standing in front of
`db/provision/dump_tenant.py` yet either. Guessing either shape here would
be exactly the mistake this file exists to avoid, so this module holds
only:

  - `DialInTransport`, the interface a caller like `pull_encrypt_store.py`
    depends on, so it never has to know which concrete channel it is
    running over;
  - `LocalProcessTransport`, a local test double that runs a producer as an
    ordinary local subprocess. It stands in for a real dial-in call so the
    pipeline's floor-check, single-recipient and never-put-before-exit-0
    properties can be proven against a real local database and a real
    producer without any remote channel existing yet;
  - `UnwiredCollectorChannelTransport`, the loud placeholder a real caller
    gets until the actual channel lands.

Open item, flagged rather than guessed at: the real transport — the one
`services/mailgun-shim`'s `GET /drain` calls "the collector's channel" —
does not exist in this repository yet. It is being built elsewhere, in a
sibling stream of work, and the collector's own shape is that stream's to
decide, not this module's to invent. Wiring a real `DialInTransport`
implementation on top of whatever that stream lands is a follow-up, not
part of this change.

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
end today, against a real producer talking to a real local database,
without depending on a remote dial-in channel that does not exist in
this repository yet.

Streams line-by-line, mirroring `db/provision/dump_tenant.py`'s own
`run_mysqldump`: a caller watching for a floor-table `INSERT` pattern
needs whole lines, and a chunk boundary that split one across two
`stdout.write()` calls would make that watch unreliable for no reason a
real remote channel would ever force on it.
