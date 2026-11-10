# render-shared-media-buckets.py

## Module overview

The estate's three shared media buckets sit behind the signing gateway
(page 21 of ghost-platform-docs, decision 1). This renderer prints the
create, versioning, lifecycle and bucket policy for each of the three, for a
location passed in. It generalises `render-media-bucket-policy.py`, which
renders one tenant's bucket and stays in use for that path.

Nothing has a default. The location, the three bucket names and the four key
identifiers (`PROJECT:ACCESS_KEY`) are required. A missing location is an
argparse refusal; a malformed one is a `PolicyInputError`.

## Who holds what

| Principal | Rights on each shared bucket |
|---|---|
| anonymous `*` | `GetObject`, `GetObjectVersion` on objects. Nothing that lists. |
| gateway real key | `PutObject`, multipart abort and parts list, `GetObject` on objects. No delete. No list. |
| backup reader | `GetObject`, `GetObjectVersion`; `ListBucket`, `ListBucketVersions`. Never writes. |
| erasure key | `ListBucketVersions`; `DeleteObject`, `DeleteObjectVersion`. |
| bucket-admin (operator) | Everything, by the storage project's default and the `NotPrincipal` exemptions. |

Each key sits alone in its own Hetzner project. Object ownership is by project,
so two keys in one project would read and rewrite each other's objects whatever
the policy says. The renderer refuses four keys that share a project or a
credential.

## Why the statements are shaped this way

- Every key in these buckets is outside the bucket's project, so the project
  default grants none of them anything. Only an explicit `Allow` naming the key
  reaches it. The renderer's tests decide with that model, not with
  `bucketpolicy.decide`, which grants every key in the bucket's own project.
- Listing is denied explicitly, with `NotPrincipal` exempting the reader, the
  erasure key and the operator. An explicit Deny is not overcome by a public
  bucket ACL. Anonymous callers and the gateway are both denied listing.
- Deletion is denied explicitly except to the erasure key and the operator.
  The gateway's own statement carries no delete, so a missing Deny would still
  leave it without delete.
- `ListBucketVersions` is removed from the configuration denial and handled
  by the listing denial, so the reader and the erasure key keep it.
- The gateway is denied listing. The storage decision leaves its listing open
  until the owner rules on it. If Ghost's `exists()` needs listing to tell a 404 from a
  403, the gateway will see 403s; that is untested and is the first thing the
  read-back exposes.

## What is not established here

- Hetzner's behaviour for these statements is not proven by this file. The live
  read-back and the console key creation are the owner's, and the read-back
  must compare the stored policy, lifecycle and versioning with the renderer's
  output for each bucket.
- The access-list rewrite that a stolen gateway key could do is not closed here.
  The storage decision suggests an explicit Deny on the access-list actions;
  that is unmeasured, so it is not added.
- The operator's control step (a list that proves the operator key is the
  right one) is omitted: no shared bucket exists before the first create.
