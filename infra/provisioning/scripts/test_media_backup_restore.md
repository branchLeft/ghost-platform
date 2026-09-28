# test_media_backup_restore.py

## Module overview

Unit tests for media_backup_restore.py.

No real network here -- `list_objects` / `get_object_with_content_type` /
`get_object` / `put_object` / `delete_object` are injected as fakes, so
these tests pin the module's own logic (the floor, the checksum comparison,
per-tenant isolation, key-opacity, the recipient-count guard, the
generation-based deletion ordering and its concurrency safety) rather than
re-proving the SigV4 signer (`test_objectstorage.py` already does that).
`age` itself IS real in `RecipientStanzaCountTests` -- the count this
module trusts is checked against real `age` output, not only against a
value this file invents -- and in `EncryptWithAgeArgvTests`, which captures
the real argv a fake `run` receives. The full chain -- real MinIO, real
Ghost, the CLI's own exit code, and a live reproduction of a
second-recipient ciphertext -- is proven by `media-backup-restore-proof.sh`.

## test_true_interleaving_the_smaller_id_run_never_deletes_the_larger_id_runs_in_progress_objects

The rule that makes concurrent runs safe -- "never delete a same-or-later
generation" (`_sorts_before`, used by `_delete_older_generations` for both
the end-of-run delete AND the orphan sweep below) -- proven by TRUE
interleaving, not merely sequential completion: the LARGER-id run is
paused mid-upload, and while it is paused, the SMALLER-id run starts AND
completes its whole backup, including its own delete/orphan-sweep step.
The smaller-id run's cleanup must never remove the larger-id run's
already-written object, because a same-or-later id is never "older" --
regardless of which run happens to finish first in wall-clock time.

## test_a_run_that_completes_before_a_stale_sweeps_deletes_land_must_survive

G0 is a good, manifested generation. Run A uploads its one object -- no
manifest yet -- and pauses right there. Run B starts: it lists the
tenant's prefix at that exact moment (G0 has a manifest; A does not, so a
stale-snapshot sweep could still count A as an orphan), then fails on its
own live read before it ever uploads or writes a manifest of its own --
but its sweep's delete calls were already issued against that stale
listing, and this test applies them only AFTER A has resumed, passed both
its presence checks, written its manifest, and deleted G0 -- modelling
those deletes landing on the wire late. The tenant must still be
restorable afterwards.
