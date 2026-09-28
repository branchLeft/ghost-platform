# media.ts

## Bucket derivation

Where one tenant's media lives, and Ghost's storage-adapter configuration
for it — derived from the descriptor's `media` union alone.

Both a local-path derivation and the bucket derivation still derive from the
slug alone, which is the isolation control. The bucket derivation being a
pure function of the slug — never a configurable field — is what keeps a
descriptor from being able to name another tenant's bucket: the schema's
`s3` media variant carries a free-text `bucket` field, so this module
derives the *expected* bucket from the slug and `validateMediaBucket` below
refuses a descriptor whose `bucket` disagrees, rather than ever trusting the
field's own value. Both `validate()` and `render()` call it, so a foreign
bucket is refused at the earliest point either reconciler could catch it,
not merely written around later.
