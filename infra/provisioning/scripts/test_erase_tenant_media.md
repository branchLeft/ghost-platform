# test_erase_tenant_media.py

Tests for [erase_tenant_media.py](erase_tenant_media.md), run as an ordinary
user with no credential, bucket or gateway.

The fakes are a versioned shard (several versions and delete markers per
object, three tenants including one whose folder starts with another's), a
gateway admin, an edge purge and a backup eraser. The ledger is a real SQLite
file built from the gateway's own migration
(`services/storage-gateway/drizzle/usage/0000_usage_ledger.sql`), so the
column names the job reads are the gateway's.

- `ErasureTests`: every version and marker under the folder goes, other
  tenants' objects are untouched, the disable comes first, rounds repeat until
  a listing is empty.
- `SabotageTests`: a planted object the ledger lacks is red, a ledger entry
  the listing lacks is red, the plants removed is green, a prefix of another
  tenant's folder refuses and deletes nothing.
- `RefusalTests`, `PacingTests`, `JournalTests`, `RegisterTests`,
  `LedgerReaderTests`: the refusals, the pace ceiling, the 503 backoff, the
  journal, and the file readers.
- `S3StoreTests`, `AdminTests`, `OpensslSigningTests`: the adapters, against a
  scripted SigV4 module, a local HTTP server and (where `openssl` can sign
  Ed25519 with `-rawin`) a real signature verified with the public half.
- `MainTests`: the command line refuses without the key, for a folder that is
  not a tenant's, and with no edge purge, and has no flag for the key.
