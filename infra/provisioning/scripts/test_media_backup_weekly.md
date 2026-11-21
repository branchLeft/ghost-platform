# test_media_backup_weekly.py

## Module overview

Unit tests for `media_backup_weekly.py`. The storage is a fake that serves the
shared buckets and takes the backup bucket's writes, and records every request;
`age` and `ssh-keygen` are the real binaries, so the encryption checks run on
real ciphertext.

## RunTests

A whole run over two tenants on two shards, with a neighbour's object on one
shard. It shows one manifest per tenant, that only each tenant's own folder is
listed and fetched, that each tenant's copy opens with its own identity and
with no other, that no request to the backup bucket and no file on disk holds
the plaintext, that a failing tenant does not stop the next, that an empty
folder passes only with the operator's `no-media`, and that SlowDown is retried,
counted and slows the run.

Sabotage proofs, each recorded red then green in the pull request:

- `test_an_encryptor_that_returns_the_plaintext_writes_nothing`: with the
  recipient-count guard removed from `media_backup_restore.py`, the run writes
  plaintext and this test fails.
- `test_a_run_refuses_two_tenants_on_one_recipient_and_reads_nothing`: with the
  shared-recipient refusal removed from `check_plan`, two tenants are
  encrypted to one recipient and this test fails.

## The other classes

`FoldersTests` (the folders file and its refusals, including one folder claimed
by two tenants), `ConfigTests` (every setting required, the 400 ceiling, no
media bucket as the backup bucket, no secret in a repr), `PacerTests` (spacing,
halving, recovery, floor), `TransportTests` (503 retried with backoff, nothing
else retried, the backoff cap) and `MainTests` (exit codes, `--check` touching
no bucket).
