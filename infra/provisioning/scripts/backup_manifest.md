# backup_manifest.py

## Why a manifest

The restore drill has to assert that a restore brought back **this tenant's**
content. A Ghost on an empty database serves 200 (LLD-9 R4). Expected values
read out of the restored database prove nothing, because whatever the restore
produced, Ghost's own install defaults included, would then agree with itself.

The expected values therefore come from the source, at backup time:

- the site title;
- the staff user, published post and member counts;
- the newest published post's title and slug.

## How it is recorded

`ManifestWatcher` watches the plaintext dump line by line, on its way into
`age`, beside the worker's floor watcher. It learns each watched table's column
order from its `CREATE TABLE`, then reads that table's extended `INSERT`s with a
small tokenizer for mysqldump's value syntax. The manifest is the same snapshot
the dump is, because it is read from the dump's own bytes. A second query
against the live database would race concurrent writes.

The worker appends the manifest to the plaintext as one final SQL comment
line before closing `age`'s input:

```
-- branchleft-backup-manifest v1 <base64 JSON>
```

So the manifest:

- is encrypted to the tenant's one recipient, like the rest of the dump;
- is covered by age's MAC;
- is shredded with the dump when the key is destroyed;
- needs no second object, and no read access for the worker's put-only key.

`mysql` ignores the line on import. Base64 keeps it free of quotes,
backslashes and semicolons.

## Failure shape

The watcher never raises into the backup. A line it cannot read sets
`error` on the manifest, the backup is still stored, and the drill then fails
on that error. A parsing defect costs a drill, never a backup.
