# tenant-tier-gates.ts

## What it is

The tenant tier's refusal and hold gates, written once as assertions, and run by
`../unit/tenant-tier-gates.test.ts` through the real entry file Ghost loads, the
real decorator, the real unix-socket transport and the real host end of the
verdict channel (`../../verdict-host/`). It is the object-store counterpart of
`demo-tier-gates.md`: the same two gates, but the decorator wraps an adapter in
the shape of Ghost's `S3Storage` over a bucket the gates read directly, and the
decorator is configured as a paying tenant's is (`wraps: S3Storage`,
`verdictSource: production`, a bucket config). Both paid tiers, `entry` and
`professional`, run the green gates; a demo runs local media and is the other
half of the pair.

## The assertions

Each is a `must(id, ...)` call. A failed one throws `TenantGateFailure` naming
its id.

| Id | Proves |
| --- | --- |
| `refusal.upload-refused` | after the service has answered the test-classification hash as a match, an upload of those bytes is refused with the typed 415 |
| `refusal.nothing-served` | neither that upload nor the one held before the answer is served, as an original, at a size, or by a direct read of its bucket key |
| `refusal.not-in-bucket` | the bucket holds no object under any key |
| `hold.upload-accepted` | with the service not draining, or the host end stopped, the upload succeeds and returns a URL |
| `hold.original-not-served` | that URL serves nothing |
| `hold.size-request-empty` | a responsive-size request returns nothing and writes no derivative |
| `hold.absent-from-bucket` | a direct read of the bucket key returns nothing because the object was never written: the key has never held an object, and no key holds those bytes |
| `hold.stays-withheld` | still true after several retry rounds, in what is served and in what the bucket holds |
| `promotion.present-in-bucket` | once the service answers clean, a direct read of the key returns the bytes |
| `promotion.served` | and the size request returns the image |
| `pair.demo-tier-refuses` | the same test-classification bytes through the demo tier's adapter also refuse |
| `age.grows-while-undrained` | `verdict_host_oldest_unverdicted_age_seconds` grows while nothing drains |
| `age.returns-to-zero` | it is zero once the verdict is in |

**Absent means never written.** The bucket double refuses a delete, as the
signing gateway in front of the real bucket does, and keeps a log of every write.
`hold.absent-from-bucket` fails on an object that was written and then hidden or
unlinked, because the key has a write in its history, and fails on the bytes
sitting under any other key. A masking adapter (one that answers not-found for a
key it wrote) passes the served-path gates and fails this one: the control for it
is in the test file.

## Every assertion has a case that must fail

Each id has a control in the test file: the same assertion run against a broken
setting (a slot with no scanning, a slot with no verdict source, a service that
answers clean, an object written to the bucket at the phase the assertion
watches, an adapter that hides what it wrote, a demo tier that accepts the
upload, a host end that never received the hash). The control passes only if the
assertion went red at that exact id. `tenantRegistry` records which ids have
passed and which have been seen red, and the last test in the file fails if any id
lacks either. The pair has both directions: a demo tier that accepts goes red at
`pair.demo-tier-refuses` while the tenant tier refuses, and a tenant tier that
accepts goes red at `refusal.upload-refused` while the demo tier refuses.

Beyond these in-test controls, the gates were run red against the real source
(see the pull request): a hold that writes the bucket before a verdict, a hold
that writes the bucket and hides it, a promotion that does not write, an
unavailable verdict read as clean, a policy that allows on one tier only (each
way round), and a host end whose age is pinned to zero. Each turns the suite red
at the assertions above, and restoring the file turns it green.

## What is substituted, and why

**The hash stage.** As in the demo gates: the adapter's key is still a SHA-256
stand-in, which the host end refuses as not a perceptual-hash key, so the
harness replaces that one function with a map from each fixture to a key of the
right shape. `demo-tier-gates.ts` owns the substitution and its guard test.

**The object store.** `S3ShapedStorage` stands in for Ghost's `S3Storage`: every
write is a command sent through a `client`, `save` names a content type and
`saveRaw` names none, and a delete is refused. The bucket is in memory. That the
real `S3Storage` behaves so against a real S3 server is proven by
`../image/scanning-storage.image.test.mjs` (hold and absence on `S3Storage` over
an S3 double) and `../image/storage-contract.image.test.mjs` (the request
shapes); this harness does not start Ghost.

**Ghost.** `TenantSlot.sizeRequest` follows Ghost's responsive-size route (serve a
derivative that exists, else read the original, resize and write; no original,
nothing).

**The test-classification hash.** The real safety service holds the real one.
Here the fixtures are synthetic bytes, and the stand-in service decides which of
them it answers as a match.

## Running it on a live slot

The gates take a `TenantSurface` (`upload`, `serves`, `sizeRequest`, `settled`,
`uploadedKeys` and a `BucketView`), not the in-process slot, so a live run is a
second implementation of that interface and the same assertions. It needs, each
of which does not exist today:

1. **A tenant slot running the real stack:** the descriptor naming
   `safety.verdictSource: "production"` so the rendered environment carries
   `verdictSource` and `verdictSocketPath` and mounts the slot's verdict volume,
   and the slot's host end of the channel running on the host. Without them a
   rendered tenant refuses every upload with a 503.
2. **The real hash stage:** the adapter computing a real perceptual hash. Until
   it does, every upload under `production` is held and nothing is ever refused,
   so `refusal.upload-refused` cannot pass on the real channel.
3. **The safety service live,** dialling in to that host end with its credential,
   able to answer the test-classification hash as a match and anything else as
   clean, and stoppable (the "verdict channel stopped" case is the host end
   stopped, then started).
4. **A real tenant media bucket,** reached by Ghost through the signing gateway.
5. **A direct reader for the bucket:** a credential that can `GET` an object,
   list a key prefix and list object versions on that bucket, held by the run and
   never printed. `everWritten` is true when the key has any version or delete
   marker; `keys` is the listing of the run's own prefix.
6. **An admin session on the slot** for the upload route, and an anonymous read
   of the public URL for `serves` and `sizeRequest`.
7. **The estate scraping the tenant host's verdict-age series,** so the age gates
   can be read from the scrape rather than from the host end's renderer. That is
   a scrape target in the estate's monitoring config.

Steps that touch the host (the host end, the service, its start and stop) are
operator steps; the harness only drives them through the `settled` and
`StandInService`-shaped seams.

## Not covered

- A run on a live tenant slot (above).
- The estate's Prometheus scraping the age. The series is read from the host
  end's own renderer, which is what the textfile it writes is made of.
- `video` and `audio` on the paid tiers (`../unit/tier-policy.test.mjs`).
