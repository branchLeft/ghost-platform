# erase_tenant_media.py

## Module overview

Erases one tenant's live media from its shard, by one operator command with the
erasure key supplied for that run. It is never run on the gateway and never
holds the erasure key on a host.

```text
ERASE_MEDIA_ACCESS_KEY_ID=... ERASE_MEDIA_SECRET_ACCESS_KEY=... \
  erase_tenant_media.py --folder FOLDER --bucket SHARD --endpoint HOST --region REGION \
    --register REGISTER.json --ledger LEDGER-COPY.sqlite \
    --gateway-admin-url URL --admin-key-file ADMIN-KEY.pem --journal-dir DIR [--max-rps N]
```

The erasure key is read from the two environment variables only. There is no
flag for it, so it is never on a command line.

## The five steps

The run stops at the first step that is not shown done, with a non-zero exit.

1. **Disable the credential.** `POST /folders/<folder>/disable` on the gateway's
   admin interface, signed as the `erasure-job` caller (Ed25519, through
   `openssl pkeyutl -sign -rawin`, so the private half is read by that process
   only). Every credential the folder has ever had must come back `disabled`,
   in this folder and this bucket. A folder the gateway knows no credential
   for is refused.
2. **Delete every version and delete marker** under `<folder>/`, by version
   id, one request each, and list again until a listing shows none (at most
   20 rounds). Before the first delete of each round the names about to be
   deleted are written to the journal.
3. **Check the result** against a fresh version listing and the write ledger.
   Each of these is a red mismatch:
   - any version or marker remains;
   - a name the shard showed that the ledger has no write for (a planted or
     unrecorded object);
   - a ledger name the listing never showed;
   - a ledger name outside the folder.
4. **Purge the edge cache** for the folder.
5. **Destroy the tenant's backup identity** through
   `erase_tenant_backup_identity.py`, which needs the control host.

## Which folders it will touch

The register (`--register`, a JSON file with an `entries` list of `tenantId`,
`mediaFolder`, `mediaBucket`) is the only source of what a tenant is. The
folder must pass the gateway's own rule (16 to 128 of `A-Z a-z 0-9 _ -`), match
exactly one entry, and be in that entry's bucket. A folder that is only the
start of another tenant's folder is refused by name. The listing prefix is
`<folder>/`, so a registered folder can never reach a longer folder that begins
with the same text, and every listed key is checked to start with it before
anything is deleted.

## The ledger

`--ledger` is a copy of the gateway's write-ledger SQLite file (`write_ledger`
table), opened read-only. Take the copy with SQLite's backup, not by copying a
live file. The ledger records a name before the gateway sends the write, so a
name for a write that failed is in the ledger and not on the shard. The check
reports it as red; the media is already gone by then, and the operator decides
whether the entry is a failed write.

An empty ledger for a folder that has objects is red. The check is only as
complete as the ledger the gateway keeps.

## The journal

`--journal-dir` holds `media-erasure-<folder>.json`, the object names seen by
this and earlier runs of the same folder, written atomically and synced before
deletes begin. A run again after a late failure (the purge, the backup
identity) finds nothing left to delete, and the check still compares the
ledger with the names the earlier run saw. The file holds names only and is
the operator's to keep or remove.

## Pace

Hetzner admits 750 requests a second per source address and per bucket, and
neither can be raised. Every request, listing or delete, is paced to
`--max-rps` (default 100). A ceiling above 300 is refused. A `503` is retried
with a backoff that starts at half a second, doubles, and caps at 30 seconds,
for at most eight attempts; any other failure is raised at once. The final line
reports the request count, the number of retries and the duration.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every step was done and checked. |
| 1 | Refused before anything changed: no erasure key, a folder not in the register, a prefix of another tenant's folder, the wrong bucket, a bad ceiling, an unreadable register, ledger or journal, no edge purge configured, the gateway unreachable or refusing. |
| 2 | Usage. |
| 3 | A step is not shown done after changes began, or the completeness check is red. Run it again. |

## What it never does

- It never reads or writes an object: the store type has list versions and
  delete a version, nothing else.
- It never prints the erasure key. An unexpected exception is reported by
  class name only.
- It never lists or deletes outside `<folder>/`.

## Not wired yet

The command line refuses a run up front, before any change, because the edge
media cache has no purge to call. The `EdgePurge` port is the seam; a run
cannot complete until an adapter replaces `UnavailableEdgePurge`.
