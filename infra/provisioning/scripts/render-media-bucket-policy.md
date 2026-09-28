# render-media-bucket-policy.py

## Module overview

Each tenant's media lives in its own Object Storage bucket, reached with a
credential allowlisted to that bucket alone. Hetzner has no IAM: the only
scoping mechanism it documents is a *bucket policy* naming access keys as
principals, so this file is the whole of the media isolation boundary. It is
rendered rather than hand-written because three of its four statements are
easy to write in a way that looks right and is not.

**What the policy has to achieve, and why each piece is shaped as it is.**

  1. Public-read but NOT listable. Readers fetch media by URL; nobody may
     enumerate the bucket, because the object names are a tenant's unpublished
     and published filenames and the bucket name is the tenant's own slug.
     Served by an Allow of `s3:GetObject` on the OBJECT path only, never by the
     `public-read` canned bucket ACL — a bucket ACL of `public-read` grants
     READ on the bucket, which in S3 semantics is LIST.

  2. Credential isolation. Hetzner's default is the opposite of what is
     wanted: "each key pair is automatically valid for every Bucket within the
     same project". An Allow therefore restricts nothing; only an explicit
     Deny does. Hence the two `NotPrincipal` denials below, which is the exact
     shape Hetzner's own documentation gives for restricting a bucket to named
     keys.

  3. Append-only media. `s3:DeleteObject` is deliberately not available to the
     tenant's own key, which is why deletion from Ghost admin returns a 403.
     That is a decision, not a gap — and it is worth nothing unless the tenant
     is also kept away from the bucket's *configuration*. A lifecycle rule
     expiring every object destroys media without ever calling `DeleteObject`;
     `PutBucketAcl` re-opens listing without touching this policy; and
     `PutBucketPolicy` replaces the whole fence. The tenant's key therefore gets
     no bucket-resource action beyond three harmless reads.

  4. The bucket must stay administrable. A `NotPrincipal` deny covering
     `PutBucketPolicy` locks the bucket permanently if it does not exempt the
     account that owns it, because the statement that would have to be edited
     is the statement doing the denying. The operator's own key is therefore in
     every `NotPrincipal` list here. Hetzner also warns that the Console stops
     being able to list a restricted bucket at all, which is worth knowing
     before an incident rather than during one.

**Why both blanket denies are enumerated rather than `NotAction`.** They were
`NotAction` until it was established that this engine stores that keyword and
enforces nothing: with it in place, any key in the project can write an object
into a tenant's media bucket, and the tenant's own key can read and rewrite the
policy that constrains it. Enumerating loses the property `NotAction` was
chosen for, that an action nobody thought of falls closed. That loss is real on
the object resource and is bought back only by keeping the lists in
`bucketpolicy.py` wider than today's need. On the bucket resource it is not
lost: `Action: s3:*` is enforced, and nothing anonymous needs exempting
there.

**The property this file still cannot establish.** Hetzner publishes no list of
supported policy Actions, Principal formats or Conditions. Every action named
here is believed enforced because a construct of the same shape was observed
working, not because the vendor documents it. That is why
RUNBOOK-tenant-onboarding.md verifies the decisions against the live bucket
before the credential is handed over, rather than treating a successful
`put-bucket-policy` as proof — a round trip compares what was stored, and
this engine stores what it will not enforce.

The principal syntax, the input charset rules and the evaluation model are in
`bucketpolicy.py`, shared with the operational-bucket generator.

## DenyBucketConfigurationExceptOperator

Every bucket-resource action except the three harmless reads, denied to
everyone but the OPERATOR — the tenant included.

The tenant's exclusion is the point, and the first draft of this file got
it wrong by putting the tenant in this `NotPrincipal` list. Hetzner's
project-wide default then applied, so the key sitting in
`/etc/branchleft/<slug>.env` inside the tenant's own container could call
`PutBucketPolicy` and replace these statements, `PutBucketAcl` and publish
the object listing, or `PutLifecycleConfiguration` and expire every object
without ever calling `DeleteObject`. "The bucket is the boundary" is only
true while the boundary is not writable from inside it.

An enumerated `Action` list, NOT the `NotAction` catch-all this statement
used to carry. That form is stored and returned verbatim by this engine
and enforces nothing: the tenant key read this policy and changed
versioning on its own bucket while the statement was in place. `NotAction`
costs the property that an unlisted sub-resource falls closed, so
`BUCKET_CONFIGURATION_ACTIONS` is deliberately wider than what Hetzner
supports today.

## DenyBucketAccessExceptNamedKeys

EVERY bucket action, denied to everyone but the tenant and the operator —
not the three reads the statement above exempts. `Action: s3:*` is a
construct this engine is observed to enforce, so the catch-all property
that `NotAction` was supposed to provide survives here: a bucket
sub-resource nobody thought of still falls closed against a stranger. It
is affordable on the bucket resource precisely because nothing anonymous
has any business there, which is not true one resource down.

This also makes the bucket unlistable *explicitly* rather than merely
un-granted, and the distinction is load-bearing: an implicit deny is
overcome by a `public-read` bucket ACL, an explicit policy Deny is not.
