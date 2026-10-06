# backup_recipients.py

## Module overview

Reads the per-tenant age recipients the backup worker encrypts to. The file
holds one `tenant age1...` line per tenant; blank lines and `#` comments are
ignored.

Each tenant's dump is encrypted to exactly one recipient, that tenant's own.
Destroying that tenant's private key then makes only that tenant's backups
unreadable, which is the erasure mechanism (LLD-9, `09-backup-and-recovery`).
There is no operator, escrow or shared recipient, because a second recipient
on any dump would let that key open it after the tenant's own key is gone.

## parse_recipients

Refuses a line that is not exactly two fields, a tenant name that is not a
valid slug, a value that is not one native age public key, a tenant listed
twice, and one recipient listed for two tenants.

## load_recipients

Opens the file with `O_NOFOLLOW`, refuses anything but a regular file and
raises `RecipientError` for an unreadable or malformed file.

## recipient_for

Returns the named tenant's recipient or raises `MissingRecipient`. There is
deliberately no default argument and no fallback: a caller that catches the
error must skip that tenant. `nightly_dump_loop.py` records the tenant as
failed, prints an `ALERT` line and continues with the others;
`backup_worker.py main()` exits 1.
