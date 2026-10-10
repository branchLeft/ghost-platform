# state_copy.py

## Module overview

Copies the two Pulumi state buckets (labels `estate` and `tenant`) into
backup copy 1 every night, encrypted to one estate `age` recipient, and
restores a copy to prove it. `ops1` pulls: no state-bearing host holds a
credential to copy 1.

Per bucket, `copy`:

1. lists the bucket and gets every current object with the source key;
2. refuses a listing that holds no `.pulumi/stacks/` object, because an empty
   listing is what a wrong bucket, a wrong key scope or an outage looks like;
3. packs the objects into one tar, builds a manifest (object names, sizes,
   sha256 of each, sha256 of the tar), and encrypts both to the single
   recipient. A header with other than one recipient stanza aborts;
4. puts `state/<label>/generations/<run id>/state.tar.age`, then
   `manifest.json.age` last. The manifest is the completion marker.

Object names (which name tenant stacks) appear only inside the ciphertext.
Every bucket is attempted; one failure makes the exit code 1 and the unit
fail. Exit 2 means the configuration was refused before anything ran.

`restore --label L --identity FILE --into DIR [--run-id ID]` decrypts the
newest complete generation, checks the tar and every object against the
manifest, refuses unsafe names and a non-empty target, and writes the
objects. The drill then points a throwaway backend at `DIR`.

## Where each configurable value is set

All in `/etc/branchleft/state-copy.env` (root, 0600), delivered to the unit
as the systemd credential `state-copy.env`:

- `STATE_COPY_RECIPIENT`: the estate `age1` public key.
- `STATE_COPY_{ESTATE,TENANT}_*`: bucket, endpoint, region and key of each
  source. The key is a read-only key (get and list) from a key-only project
  of its own, never the state key the stacks write with. The code needs only
  get and list and checks nothing about the key's rights.
- `STATE_COPY_DEST_*`: copy 1 and its put-only key.

## Retention

The estate's erasure window is about 46 days: 10 days current, one day for
the daily pass, 35 days noncurrent. Retention is not set here; both
keep-periods are set to that window:

- Copy 1's `state/` lifecycle is set by
  `db/provision/configure_backup_bucket.py`: `--state-expiration-days`
  (default 10) then `--state-noncurrent-days` (default 35).
- The state buckets' own noncurrent expiry is set by
  `configure_state_bucket.py --noncurrent-days` (default 46).

## Metrics

Written to `state_copy.prom` in the backup worker's exporter directory:
`state_copy_bucket_configured` (written before any copy, so a bucket that
has never succeeded is visible), `state_copy_last_success_timestamp_seconds`,
`state_copy_last_object_count`, `state_copy_last_bytes`, each labelled
`bucket`. A failed bucket keeps its old success time. The alert
`StateCopyStale` is in shared-infra `hetzner/monitoring/render.ts`.
