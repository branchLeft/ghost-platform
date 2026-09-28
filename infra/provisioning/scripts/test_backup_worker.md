# test_backup_worker.py

## Module overview

Unit tests for backup_worker.py, through its real entry points —
`run_tenant_dump` AND, separately, `main()` itself — against the REAL
`db/provision/dump_tenant.py`, never a fake standing in for the producer
itself. `mysql` and `mysqldump` are the two binaries faked (as tiny shell
scripts placed first on `PATH`), because a real MySQL instance is the
local-container proof this repo's own convention (see
`db/provision/test_extract_tenant_binlog.py`) keeps out of the fast,
hermetic unit suite.

What IS real here: `dump_tenant.py`'s own Python code (its floor checks,
its env-forwarding allowlist, its argument parsing),
`dial_in_transport.LocalProcessTransport` spawning it as a genuine
subprocess, `age` encrypting and decrypting the result, and, in
`MainCopyWiringTests` below, `main()`'s own argument parsing and
`BACKUP_WORKER_COPY_*` env-var wiring. The only things this file invents
are the two MySQL client binaries, the storage "copies" (plain local files
standing in for the two cloud buckets in the `run_tenant_dump`-level tests
— neither cloud credential is this suite's to provision), and, in
`MainCopyWiringTests`, `shared_objectstorage.put_object` itself — that
boundary is mocked there specifically so `main()`'s real env-parsing and
copy-selection logic runs unmocked against synthetic, dummy credential
values, with no real network call.

## WiringSabotageForTheCopySelectionTests

Proves the required/optional distinction is actually load-bearing — not by
breaking `backup_worker.py`'s shipped code (a permanently-red test would
fail every future CI run, which is not what "record red" means here), but
by demonstrating that the OLD shape — `_copy_target_from_env(...,
required=True)` for the secondary copy too, which is exactly what `main()`
did before this fix — refuses the same environment the fixed `main()`
accepts today. Both are real, executed assertions against the real
function, not prose; the live edit/run/revert transcript against `main()`
itself is recorded separately, since that half genuinely does require
breaking and restoring the shipped file.

## WiringSabotageThroughTheRealEntryPointTests

Proves the floor gate in `run_tenant_dump` is actually WIRED to
`pull_encrypt_and_store`'s `post_stream_check` parameter — not merely
present as a method nobody calls.

This class deliberately does NOT run the real `dump_tenant.py`: that
producer's own `run_mysqldump` already raises `FloorError` (a nonzero
exit) the moment a floor table's `INSERT` never appears, so a dump
reaching this worker with the settings floor missing but a 0 exit is
never produced by the real producer — it is exactly the shape a
DIFFERENT or future producer, or a stream corrupted between the
producer and this worker, could still produce. That is what this
worker's own independent watch exists to catch even so, and this class
isolates it with a bare shell command as the "producer" — a fake one,
on purpose, so the real `dump_tenant.py`'s own floor check (proven
against separately above) cannot be the thing making this pass.
