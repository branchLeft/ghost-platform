# objectstorage.py

## Overview

Minimal SigV4 client for Hetzner Object Storage.

Stdlib only. The two automated write pipelines (nightly dump, binlog
shipping) each write one object per run and read nothing back, so they
only ever use `put_object`. `list_objects` and `delete_object` exist for
`prune_backups.py`, which has to read the bucket's own listing to decide
what is safe to remove. `get_object` and `get_object_with_content_type`
exist for the media backup/restore pipeline
(`infra/provisioning/scripts/media_backup_restore.py`, reached via
`shared_objectstorage.py` like every other org/control-side caller): it
pulls a tenant's live objects (with their Content-Type, so a restore can
serve them the way Ghost did) to back them up, and reads its own
ciphertext back with `get_object` to verify a restore, so it is the one
caller here that reads an object's body rather than only its listing. The
signing algorithm is the same one
`shared-infra/hetzner/scripts/probe-object-storage.py` proves works
against this endpoint; path-style addressing is mandatory there for the
same reason it is here -- a dotted bucket name falls outside the
endpoint's one-label wildcard certificate.

THIS IS THE ONLY SIGV4 IMPLEMENTATION IN THIS REPOSITORY, AND IT IS
SHARED. `infra/provisioning/scripts/verify-bucket-fence.py` sends every
one of its probes through `signed_request` below, reached via
`infra/provisioning/scripts/shared_objectstorage.py`. Two copies of a
signing implementation is how one of them rots while the tests keep
passing against the other, so the verifier imports this file rather than
restating it -- and this file stays here, rather than moving somewhere
both trees can see, because `db/RUNBOOK-db.md` provisions db1 by copying
`db/provision/` to the host with `scp -r` and running the scripts in
place, so every module they import has to be inside that one directory.

The split between `signed_request` and the named operations below is
deliberate. The named operations raise on anything but success, which is
what an unattended pipeline wants. The verifier must reach a *verdict* on
a refusal, including telling `AccessDenied` apart from `InvalidAccessKeyId`
when both arrive as HTTP 403, so it needs the response rather than an
exception -- `signed_request` interprets nothing and hands back whatever
came off the wire.

## urllib_request

One HTTP request, returning `(status, body)` for ANY response.

A 4xx is a response, not a failure: `AccessDenied` and `InvalidAccessKeyId`
both arrive here as 403 and only the body tells them apart, so neither may
be collapsed into an exception on the way back. `ObjectStorageError` is
raised only when no response arrived at all.

A body is sent whenever there is one, and for `PUT`/`POST` even when it is
empty: `data=None` makes urllib send no `Content-Length`, which this
endpoint answers with `411 Length Required` for a zero-byte PUT.

`http.client.HTTPException` is caught alongside `OSError` because a
truncated or malformed response is not an `OSError` and would otherwise
escape as an exception type no caller expects. The fence verifier removes
its probe objects in a `finally`-shaped path around these calls, so an
exception it does not recognise leaves objects behind in a production
bucket.

## get_object_with_content_type

Like `get_object`, but also returns the object's stored Content-Type.

Media has a reason `get_object`'s other callers do not: Ghost serves an
uploaded file by the content type it was stored with, and a restore that
recreates the exact bytes but writes them back as
`application/octet-stream` is a restore a browser will download instead
of rendering -- silently wrong for video, audio and any direct link,
while every checksum still matches. Falls back to
`application/octet-stream` only if the response genuinely carries no
Content-Type header, never as a way to skip reading one that is there.

The lookup is case-insensitive: HTTP header names are case-insensitive by
spec (RFC 9110 §5.1), and `transport` may hand back whatever casing a
given server or a test's fake happened to use -- `Content-Type`,
`content-type`, or anything else. Matching only the canonical spelling
would silently fall back to octet-stream against a server that sends a
differently-cased header, exactly the failure this function exists to
avoid.

## signed_request

One signed request, returning `(status, body)` and interpreting neither.

Every operation the fence verifier needs goes through here, so that a
denial probe and the control probe that licenses it are the same kind of
request, signed by the same code. A control on a different transport
establishes nothing about the transport the probe used.

Nothing here decides what a response means. That is the caller's job, and
keeping it out of this function is what stops a status code from becoming
a verdict on its own.

## owner_id

The storage account this credential belongs to, from ListAllMyBuckets.

The only way to learn, from the credential itself, which account a bucket
policy has to name. A policy principal is
`arn:aws:iam:::user/<owner>:<access key>`, and both halves have to be
right: an ARN carrying the correct key under the wrong account names a
principal that does not exist, which turns a `NotPrincipal` exemption into
an exemption for nobody. That is unrecoverable on a statement covering
`PutBucketPolicy`, and no offline check can catch it, because a rendered
policy is self-consistent with whatever account id it was given.

Service-level, so no bucket policy governs it.

## parse_owner_id

`Owner/ID` out of a ListAllMyBuckets response, or None if it is absent.

Separate from `owner_id` because the fence verifier resolves the same
value from a response it classified itself, rather than from one that
raised.

`anonymous` is returned as-is and is deliberately NOT special-cased here:
this endpoint answers an unsigned `GET /` with HTTP 200 and that owner id,
so the string is a real answer to the question "who signed this request"
-- the answer being "nobody". A caller resolving an account to name in a
policy has to refuse it; a caller parsing a response has no business
deciding that.
