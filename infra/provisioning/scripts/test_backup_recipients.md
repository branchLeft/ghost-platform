# test_backup_recipients.py

## Module overview

Unit tests for `backup_recipients.py`: parsing, the refusal of a shared or
malformed recipient, lookup with no fallback, and loading without following
a symlink. The loop-level proof (each tenant's ciphertext opens with its own
identity and no other, and a tenant with no recipient is skipped) lives in
`test_nightly_dump_loop.py`'s `PerTenantRecipientTests`, against real `age`.
