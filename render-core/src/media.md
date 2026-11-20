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

## The tenant folder

A `gateway` tenant's media is one folder in a shared shard bucket, written only
through the storage gateway (page 21 of the platform docs, decision 1). The
folder is Ghost's `tenantPrefix`, and Ghost writes it into every published
media URL, so it is opaque and random, recorded at provisioning, and never the
tenant's name. `validateMediaFolder` refuses a folder outside the gateway's
own alphabet and length (16 to 128 of `A-Z a-z 0-9 _ -`), and one that equals
or contains the slug in any letter case. The descriptor must carry it: a
missing folder is refused at the shape check, so nothing downstream can fall
back to the slug. `validate()`, `render()` and the identity all check it.

`validateMediaShard` refuses a shard that is not a bucket name the gateway
admits, that carries `MEDIA_BUCKET_PREFIX` (a per-tenant bucket), or that
contains the slug. Which shard a folder is in is recorded, never computed.

## The media address

`cdnUrl` for a `gateway` tenant is `zones.mediaOrigin`, the platform's own
media address, with no bucket and no supplier in it. Readers load
`<mediaOrigin>/<folder>/content/images/...`, and the edge maps the folder to
its shard. A shard move or a change of supplier then changes no published URL.
`validate()` refuses a `mediaOrigin` that is not `https://<host>` with no
port or path, or whose host is outside `zones.ownedDomains`. The value is the
caller's to supply, as every other zone is; which hostname it is, is the
owner's choice and is not named in this repository.

## The two object-storage kinds

`s3` (a bucket and a Hetzner key per tenant) is kept, unchanged and with
byte-identical output, for the waypoint's demo-tenant slot until the gateway
is live. The descriptor's `media.kind` is the switch: a tenant moves to the
gateway by a reviewed change of its descriptor to `gateway`. Once no
descriptor names `s3`, the variant, `mediaBucketName`, `mediaPublicBaseUrl`
and the per-tenant bucket tooling are removed in a later major version.
