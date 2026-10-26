# keyStore.ts

## keyStore

One folder per slot under `BROKER_ADMIN_KEY_DIR`, mode 0700, and one file
in it, mode 0600, both owned by the broker account (the unit runs as it).
The base folder is tightened to 0700 on every write, so a folder created
earlier with a looser mode does not stay that way. Ghost's containers and
the router run as other accounts and cannot read it.

The slot name must be a plain literal before it becomes a path, and a slot
folder that is a symlink is refused, so a planted link cannot point a
write or a delete somewhere else. Only a value shaped like a Ghost Admin
API key is stored or handed back; a corrupted file is an error, not an
empty key.

The write is atomic (`atomicFile.ts`): a reader sees the old token or the
new one, never half of one. `remove` is what a reset calls.

Reading checks the file before trusting it: it must be a plain file (not a
symlink), mode exactly 0600, and owned by the account the broker runs as.
Anything else is refused as an error, so a token another account could
have read, rewritten or planted is never used. The key file is opened once
without following symlinks, and without blocking on a named pipe. Every
check and the read itself use that one open handle, so the file that was
checked is the file that was read. The read does not check the slot folder
above the file: only the write and remove paths refuse a symlinked slot
folder. The no-follow applies to the key file itself, not to the folders
above it.
