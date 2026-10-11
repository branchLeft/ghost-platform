# Scanning storage decorator

Wraps whatever storage adapter Ghost is configured with -- local disk or S3 --
and refuses a known-bad upload before it ever reaches the wrapped adapter.
Design: `ghost-platform-docs/19-try-it-now-design/07-safety-toolbox.html`,
including its later amendments on the verdict-channel timeout/hold ruling
and on which storage backend the professional tier runs, and the
cross-document review that found the coverage gap an earlier,
inheritance-based draft of this component left.

`src/ScanningStorageAdapter.js` is copied by the root `Dockerfile` into
Ghost's internal storage adapters directory,
`core/server/adapters/storage/`, alongside the sibling files it requires and
alongside the built-in adapters (`LocalImagesStorage.js`,
`LocalMediaStorage.js`, `LocalFilesStorage.js`, `S3Storage.js`) it wraps by
name. It is never placed in the content directory, which a tenant can write
to. It is inert until a tenant's config selects it for a storage feature.

## Scope

This story builds the decorator, its `save()`/`saveRaw()` interception, the
`Check`/`Verdict`/`Policy` seams the rest of the safety toolbox plugs into,
an in-process `VerdictClient` test double, and the hold/promote mechanism,
ruled on by the platform owner, that accepts an upload with no verdict and
serves nothing until one arrives. It does **not** build:

- **The real verdict channel.** The safety service that checks a hash
  against a known-material database lives in a separate repo, built by a
  separate story, per the platform owner's own ruling that it should be
  extensible to other organisations later. `ScanningStorageAdapter.js`
  constructs a `FakeVerdictClient` from its own config only when
  `storage__<feature>__verdictSource=in-process-fake` is set outright, for
  demo, dev and test paths. With that unset the adapter has no verdict
  source and refuses every new upload with a 503 (see "No verdict source"
  below); nothing here guesses the real channel's wire format or transport.
  Because there is no real channel, "a later verdict arrives" can only
  mean one thing this decorator can observe: the same in-process
  `VerdictClient` answering differently on a later call (`src/hold.js`
  polls for that). `Policy.decide` can still return `'flag'`, for the
  advisory/text route, and the adapter fails loudly rather than guessing
  a behaviour if it ever sees one.
- **A behaviour for video (`storage:media`) or arbitrary files
  (`storage:files`).** PDQ is an image hash; the design names video as
  undesigned. Which behaviour to build for either content type is an open
  product decision for the platform owner, not made here. The decorator
  class wraps any of the three storage
  features identically, and `PdqKnownMaterialCheck` is attached unconditionally
  regardless of which feature the instance services -- it is not
  image-specific, it just hashes whatever bytes it is given. So configuring
  `storage:media`/`storage:files` with this adapter today is **not**
  structurally inert: a digest in `refuse` would be refused on video or an
  arbitrary file exactly as on an image. It is harmless only because no
  committed config wires media/files to this adapter and `refuse` defaults
  to empty -- inert by absence of configuration, not by construction.
  Nothing here chooses a *scanning* behaviour for video or files (no check
  computes a video-appropriate hash, no policy is tuned for that content
  type); the byte-hashing plumbing simply doesn't distinguish them.

**Theme uploads bypass storage adapters entirely.** Ghost's theme
upload/activation path writes to local disk directly and never resolves a
`storage:*` adapter, so a theme zip -- which can carry arbitrary image bytes
-- has no path through this decorator, regardless of configuration. Outside
this story's scope; named here so a reader doesn't take this decorator for
a complete answer to "what bytes can reach a reader."

## Replacing a same-name thumbnail

Ghost replaces a thumbnail by calling `exists`, then `delete`, then `save`
with the same name. The storage gateway refuses every delete, and a `save()`
that finds the name taken would pick a new one. So `delete()` is never
forwarded: it is remembered for `overwriteWindowMs` (default 60000), and the
next `save()` of that name writes the same key, scanned like any upload. The
previous version of the object stays recoverable through bucket versioning. A refused
replacement leaves the old thumbnail in place. The write goes through
`saveRaw`, which sets no content type on object storage.

## Configuration

Ghost config, normally set as environment variables on the tenant's
container, one block per storage feature (`images`, `media`, `files`):

| Env var | Meaning |
|---|---|
| `storage__images__adapter=ScanningStorageAdapter` | Selects this decorator for the `storage:images` feature. |
| `storage__images__wraps=LocalImagesStorage` | The adapter class this decorator wraps, resolved from the same directory Ghost's own adapter manager resolves any adapter from -- `LocalImagesStorage`, `LocalMediaStorage`, `LocalFilesStorage` or `S3Storage`. |
| `storage__images__wrappedConfig__*` | Passed straight through to the wrapped adapter's own constructor (e.g. `storage__images__wrappedConfig__bucket` for `S3Storage`). `LocalImagesStorage`/`LocalMediaStorage`/`LocalFilesStorage` ignore it; they always self-configure from Ghost's own `getContentPath`. |
| `storage__images__quarantinePath` | Where a refused upload's bytes are written, named by digest. Always local disk, regardless of which adapter is wrapped -- quarantine is never the served location. |
| `storage__images__verdictSource` | `in-process-fake` selects the in-process fake verdict client, which answers no-known-match for everything it was not seeded to refuse, so it scans nothing. For demo, dev and test paths only. Unset, empty or any other value means no verdict source: every upload is refused. Matched exactly. |
| `storage__images__refuse` | A JSON object of `verdict key -> {classification, matchType}` (the key is a PDQ hash, see "The verdict key is a PDQ hash"), seeding the in-process fake verdict client. Empty or unset refuses nothing. Has no effect without `verdictSource=in-process-fake`. |
| `storage__images__unavailable` | A JSON array of verdict keys the fake verdict client answers `'unavailable'` for, until told otherwise -- proves the hold branch, with no real channel to simulate an outage or a timeout through. Empty or unset holds nothing. Has no effect without `verdictSource=in-process-fake`. |
| `storage__images__resolvePath` | A directory the fake verdict client polls for `<key>.json` files (the key in URL-safe base64 without padding), letting an image-test driver in a separate process "deliver" a verdict for a held upload by writing one. Never used outside the image-test harness, and needs `verdictSource=in-process-fake`. |
| `storage__images__holdRetryMs` | How often a held digest is first re-asked. Incidental, like the verdict budget in `checks.js` -- defaults to 2 seconds. |
| `storage__images__holdMaxRetryMs` | The ceiling that interval backs off to on repeated non-answers -- a bound on the polling *rate* during a prolonged outage, never on how long a hold lives. Defaults to 60 seconds. |
| `storage__images__holdMaxFailures` | How many consecutive retries may *fail* (a throw from the filesystem or the wrapped adapter, not a verdict that is still pending) before the hold is stuck. Defaults to 8. |

The same keys apply under `storage__media__*` and `storage__files__*`.
Wrapping `media`/`files` today only makes sense once a `Check` exists for
that content type; until then it is configuration with no effect.

## The seam

```
Check       { kind: 'media' | 'text', blocking: boolean, run(subject): Verdict }
Verdict     { classification: string | 'unavailable', matchType?, confidence?, source, evidence }
Policy      { decide(Verdict, Context): 'allow' | 'refuse' | 'hold' | 'flag' }
```

The adapter runs only the checks whose `blocking` is `true`, on `save()` and
`saveRaw()`. An advisory check (`blocking: false`) is filtered out before it
is ever invoked by this adapter -- it can never acquire the power to refuse
a customer's upload by construction. `PdqKnownMaterialCheck` (`src/checks.js`)
ships `blocking: true`; its two hash primitives are injected, and
`src/wiring.js` is the one place they are chosen: `digestBytes` (SHA-256,
the content digest that names files) and `pdqHashOfImage` (the PDQ
perceptual hash the verdict client is asked about). See the next section.

### The verdict key is a PDQ hash

Two different things name an upload, and they are never confused.

- **The content digest** (SHA-256, hex) names the exact bytes: the
  quarantine file, its `.refused.json` record and `.holds.json` sidecar, and
  the check that bytes read back are the bytes written. A verdict's
  `evidence` is always this digest, whatever the verdict client echoes.
- **The verdict key** (a PDQ hash, the canonical base64 of 32 bytes) is what
  the verdict client is asked about, and so what `storage__images__refuse`
  and `storage__images__unavailable` are keyed by. A resized or recompressed
  copy of a picture has a different digest and a nearby key; that is the
  point. A key is never used as a file name.

`src/pdq-hash.js` is a JavaScript port of the reference implementation's
pixel-to-hash stage (facebook/ThreatExchange, `pdq/`, BSD; its licence is
`src/THIRD-PARTY-LICENSE-ThreatExchange-PDQ.txt`, shipped beside it, and a
test fails if it is altered or missing). `src/pdq.js` decodes the image with
`sharp`, which is a dependency of Ghost itself and so is resolved from
Ghost's own tree inside the image; it is a dev dependency here, never
bundled. The decoder is loaded on first use: if it were missing, every upload
would have no hash and be held, with `PDQ_DECODER_UNAVAILABLE` logged once at
start-up, rather than stopping Ghost from starting.

What yields **no hash** is never allowed on that basis (the check answers
`unavailable`, which the policy holds, and the verdict client is not asked):
empty or non-image bytes, anything that is not JPEG, PNG, WebP, GIF, TIFF or
AVIF/HEIF (so SVG and ICO), a side under 5 pixels, bytes over 64 MiB, a
picture over 100 megapixels. What the decorator then does for video, audio
and arbitrary files is the open product decision, not made here.

What is hashed: the stored pixels. EXIF orientation is not applied and
transparency is dropped, as the reference's own decoder does. Anything with a
side over 512 pixels is first shrunk to 512 x 512, as the reference does.
Correctness is measured against the reference, not asserted: the test data
and its recorded hashes are in `test/fixtures/pdq-reference/README.txt`.

### No verdict source

An adapter with no verdict source cannot vouch for any upload, so it
declines them all: `save()` and `saveRaw()` throw a typed 503 before the
file is read, hashed, sealed or written, and nothing is quarantined (a
refusal here is not a verdict on the bytes, so no digest is remembered as
refused). Reads, `exists()` and `serve()` are untouched, so what is already
stored, resized variants that already exist included, keeps being served,
and a hold left by an earlier process stays held. Every write goes through
the same two methods, so Ghost's own internal writes are refused too: an
on-demand resized image that does not exist yet (Ghost's resize middleware
passes the error on rather than falling back to the original), a bookmark
thumbnail, and an inlined external image. Two log lines on the error stream carry `SCANNER_UNCONFIGURED`: one at
construction, and `UPLOAD_REFUSED_SCANNER_UNCONFIGURED` on every refused
upload. This is distinct from an outage of a configured channel, which is
held, not refused (below). Details: `src/verdict-source.md`.

### The hold branch

A `'hold'` decision never throws: the upload is accepted and returns a URL,
and `src/hold.js` polls the same checks against the held digest until a
definitive answer arrives -- there being no real channel, that is the only
way "later" can mean anything here. `'allow'` promotes; `'refuse'` moves it
to quarantine permanently, exactly as a synchronous match would, with no one
left waiting to hear about it. A digest that never resolves stays held
forever; nothing here ever decides to serve on a stale or absent verdict.

**Both backends now write nothing to the wrapped adapter until promotion --
the design's own words for the local backend, "held outside the served
tree," rather than local-only advice.** An earlier version of this decorator wrote the
real bytes through the local wrapped adapter immediately and relied on
`exists()`/`read()`/`serve()` to withhold them from memory alone; review
cycle 1 found that a process restart while a digest was held -- this repo's
own CD queues a deploy on every merge to `main`, so this is the single most
ordinary event in the system's life, not a contrived one -- reconstructed
an empty `HoldRegistry` and served the file with no verdict at all. There is
no masking left to lose: `exists()`/`read()`/`serve()` are pure delegation
again, and withholding is simply that nothing has been written yet.

The target path is computed by this decorator itself on both backends, named
by digest rather than through the wrapped adapter's own `getUniqueFileName`
-- two different held uploads sharing an original filename would otherwise
both compute as free (nothing has been written for either) and collide on
promotion. The URL differs only in shape: a bucket config (`S3Storage`'s
shape) builds an absolute, CDN-hosted URL from `wrappedConfig.cdnUrl` (or
`.endpoint` + `.bucket`); anything else builds a local, site-relative one.

**Restart-safety.** The quarantine directory is the only source of truth,
never this process's memory. A hold's bytes are quarantined immediately
(exactly as a refusal's are), with a `<digest>.holds.json` sidecar recording
which target path(s) are waiting on it -- the only way to tell a still-
pending hold apart from a permanently quarantined refusal, since both live
at `<quarantinePath>/<digest>`. `ScanningStorageAdapter`'s constructor calls
`HoldRegistry#resumeFromQuarantine` synchronously, before it returns, so a
restarted process resumes every pending hold before it can serve a single
request. Bytes are never held in memory for a hold's full (potentially
unbounded) lifetime either: `#retry` re-reads them from quarantine on every
poll rather than keeping a resident buffer, whether the hold is fresh or
resumed. Polling backs off (`holdMaxRetryMs` caps the interval) on repeated
non-answers -- bounding the resource cost of a prolonged outage without
ever bounding how long a hold itself is allowed to live.

**One quarantine, three features.** Ghost constructs one decorator per
storage feature (`images`, `media`, `files`) and never tells it which
feature it serves, while a deployment gives all three the same
`quarantinePath`. The sidecar is therefore keyed by owner --
`{"owners": {"<wraps>:<storagePath>": [targetPaths]}}`, the wrapped
adapter's `storagePath` being what differs between features on both
backends -- and a restarted decorator resumes only its own owner's
targets. Without that, whichever feature's decorator polled first would
promote another feature's hold into its own served tree and delete the
bytes the owning feature was still waiting on, so the upload would never
be served. When the same bytes are held by two features, each promotes
into its own tree and only the last to release the digest removes the
bytes. A sidecar with no `owners` map is left held and unresumed, and
logged, rather than guessed at.

**A refusal by any feature is final for every feature.** A refusal --
synchronous, or a held digest's later match -- writes the bytes, then a
`<digest>.refused.json` record beside them. That record is the sealed
record's marker: every feature checks it before asking for a verdict on an
upload, and before each promotion of a held digest, so bytes one feature
refused are never served by another, whatever its own verdict says
(positive verdicts never expire). Bytes a refusal record names are never
deleted by this decorator; retention and release are the reporting
runbook's, not this code's. An upload is checked against the record both
before its verdict is asked for and again after a clean one, so a refusal
sealed by another feature while the verdict was in flight still wins.

**Sealing order, across processes.** More than one process shares a
quarantine directory: during a blue/green swap both colours mount the same
content volume, and the new colour resumes the old one's holds under the
same owner key. So the protocol relies only on atomic operations on one
filesystem (`rename`, and a record that appears by `rename`), never on the
event loop.

- `sealRefusal` has two steps. _Write record_: the record is renamed into
  place. _Ensure bytes_: only then are the bytes made present, kept if they
  match, else a `<digest>.releasing.*` copy is moved back, else they are
  rewritten from the buffer in hand.
- `releaseBytes`, the only code that removes quarantined bytes (a hold's
  last-owner promotion), has three. _Move aside_: rename `<digest>` to a
  unique `<digest>.releasing.<pid>.<random>`. _Check_: look for the record.
  _Finish_: if there is one, rename the copy back, otherwise unlink the
  copy. Only the aside name is ever unlinked.

If write record lands before check, the releaser sees the record and puts
the bytes back (if ensure bytes already restored or rewrote them, the
rename-back finds nothing or replaces them with identical bytes). If check
comes first, then move aside came before write record, which comes before
ensure bytes, so ensure bytes finds `<digest>` gone and restores or
rewrites it; finish unlinks only the aside name. Every interleaving ends
with the record and the bytes. A crash between write record and ensure
bytes leaves the digest refused, and its next refusal rewrites the bytes.
A refusal cannot leave bytes with no record. A crash between move aside
and finish leaves an aside copy. Each adapter sweeps them at start-up:
restored if the digest is refused, deleted otherwise. That is safe against
a live releaser for the same reason finish is. A record that cannot be read
for any reason but absence counts as present: a promotion fails (and is
retried, then stuck), a release puts the bytes back, and a sweep leaves the
copy. `test/unit/cross-process.test.mjs` runs a sealer and a releaser as
two real processes, pausing each between its steps, in all six orders.

The hold sidecar's read-modify-write is still single-process, which is a
safety-neutral but real availability gap: a held digest is never served
and never loses sealed bytes, but during a swap both colours re-arm the
same holds, so a hold one colour promotes can fail its retries in the
other and raise a false "hold stuck" alert, and two processes updating
one sidecar at once can drop an owner's entry, leaving a hold that is
never resumed and never marked stuck, with nothing logged.

**Why the registry is shaped as it is.** There is no real verdict channel
yet, so "a later verdict arrives" means the same in-process `VerdictClient`
answering differently on a later call, and `HoldRegistry` polls for it at
its own cost rather than the upload's. It never keeps a held buffer
resident: every retry re-reads the bytes from quarantine. Resumption after
a restart is synchronous, from the adapter's constructor, and only
re-derives which digests are pending; the bytes are read on the first
retry.

**Quarantine reads are verified.** Every quarantine write (bytes, sidecar,
refusal record) goes to a temp file, is fsynced, then renamed into place, so
no reader ever sees a partial file. Every retry hashes the bytes it reads
back and compares them with the digest they are filed under before any
verdict is asked for; bytes that do not match are never judged or promoted.
A later upload of the real bytes replaces a copy that does not match.

**Stuck holds.** A hold whose quarantined bytes do not match their digest,
or whose retries fail `holdMaxFailures` times in a row (backing off
exponentially up to `holdMaxRetryMs` between failures), is *stuck*: its
retry loop stops, it is never promoted, and its bytes and targets stay on
disk. It is logged once with the fixed prefix
`ScanningStorageAdapter: hold stuck` and recorded in its sidecar as
`"stuck": {"<owner>": {"reason": "..."}}`; a restart that finds it logs the
same line again rather than resuming it. To retry a stuck hold once its
cause is fixed, remove that owner's `stuck` entry from the sidecar and
restart Ghost.

## What Ghost's extension point does, and the traps in it

Ghost 6.55.0's `handle-image-sizes.js` (`frontend/web/middleware`) reads,
checks and writes through `storage:images` for on-demand responsive
derivatives; `S3Storage.ts`/`LocalStorageBase.ts` implement `save`,
`saveRaw`, `exists`, `read`, `delete`, `urlToPath` and `serve`.

1. **The adapter manager's `getAdapter` checks `instanceof` the registered
   base class (`ghost-storage-base`'s `StorageBase`) and that every name in
   `requiredFns` (`exists`, `save`, `serve`, `delete`, `read` -- not
   `saveRaw`) is a function.** This decorator extends `StorageBase` itself
   and composes with the wrapped adapter instance, so both checks pass
   regardless of which adapter it wraps.
2. **`requiredFns` does not name `saveRaw`, but `handle-image-sizes.js`
   feature-detects it with a plain `typeof` check and silently disables
   responsive images for every tenant if it is missing.** The adapter
   manager's own validation would not catch a decorator that dropped
   `saveRaw` -- only a real upload-and-resize round trip does.
3. **A decorator that subclassed one concrete adapter instead of composing
   with it would leave every other adapter type unwrapped, silently, with
   every test for the adapter it did subclass green.** The professional
   tier runs `S3Storage`; a subclass of the local adapter is not in
   its path at all.
4. **`ScanningStorageAdapter.js` never requires `ghost-storage-base` or
   `@tryghost/errors` unconditionally at the top of the testable module.**
   Both are Ghost core's own dependencies, already installed in the built
   image; the entry file injects them, and the factory (`src/scanning-storage.js`)
   takes the base class and the errors module as parameters, so the decorator's
   own logic is unit-tested without installing Ghost's package tree.

## Tests

```sh
npm ci && npm run coverage                       # unit, 90% threshold on every metric
docker build -t ghost-platform:ci ../..
IMAGE=ghost-platform:ci npm run test:image       # real Ghost 6.55.0 in Docker
```

The image test (`test/image/`) drives a real Ghost 6.55.0 container through
the real adapter manager: a refused upload (415, typed error, quarantined by
digest, nothing in the served tree), a clean upload, post creation, the
public site, the admin API and an on-demand resize -- all still working
after a refusal -- and the same refusal proven again with the decorator
wrapping `S3Storage` against a local S3-compatible double
(`adobe/s3mock`, chosen over `minio/minio` because the latter is not
pullable from this environment without registry authentication). Upload-time
resize is disabled in the test containers (`imageOptimization__resize=false`)
so each upload hashes exactly one set of bytes, rather than the processed
and untouched-original copies Ghost otherwise saves separately with
different bytes -- a real property of Ghost's own upload path, not of this
decorator, and orthogonal to what these tests prove.

The same file also proves the hold branch on both tiers, with the
verdict client configured to never answer (`storage__images__unavailable`):
an upload still returns 201 and a URL; that URL, an on-demand size request
for it, and -- on the object-storage tier -- a direct read of the bucket key
all return nothing; and a held object that never clears is never served (the
control case). Delivering a clean verdict from the test driver, a separate
process from the container, uses `storage__images__resolvePath` (see
`src/verdict-client.js`'s own comment) rather than anything that guesses the
real channel's wire format.

**Restart-safety is proven against a real container restart, not simulated:**
upload while held, `docker restart` the same container (same writable layer,
entrypoint killed and started again -- what a deploy, a crash, an OOM kill or
a health-check restart all look like from the adapter's own side), assert
the upload is still withheld immediately afterward and that both the
quarantine bytes and the `.holds.json` sidecar survived, then deliver a
clean verdict only after the restart and assert it still promotes and
serves.

**A refusal in one feature is proven against a real Ghost too:** the files
feature refuses the bytes the images feature is holding, the images
verdict then comes back clean, and the image must stay unserved with the
sealed bytes and `.refused.json` still in quarantine.

**Bind-mount ownership.** The base image's entrypoint chowns everything
under the content directory to `node` on every boot, including the
`resolvePath` mount the hold tests write verdicts into. A `mkdtemp`
directory (mode 0700) would then deny the test runner both its mid-test
verdict writes and its teardown. So the test chmods the directory 0777
before the container starts, and `reclaimHostOwnership` chowns it back
from a throwaway root container before teardown as a second line of
defence.

## Storage request contract

`test/image/storage-contract.image.test.mjs` runs the built image (the base
image is pinned by digest in the root `Dockerfile`) behind this decorator,
against a recording S3 double (`test/helpers/recording-s3-double.cjs`), and
asserts the exact set of request shapes Ghost 6.55.0 sends to storage. The
signing gateway in front of the object store allows these shapes and no
others, so a Ghost version that adds or changes one must fail here, before it
reaches a tenant. `build.yml` already runs every `test/image/*.image.test.mjs`
file against each pull request's image, which is where a Ghost bump lands, so
the contract needs no workflow of its own.

The set is seven shapes: `PutObject`, `CreateMultipartUpload`, `UploadPart`,
`CompleteMultipartUpload`, `AbortMultipartUpload`, `HeadObject` and
`GetObject`. No delete and no list call is ever sent. Each is produced by a named
caller, asserted per scenario in the test:

| Caller | Shapes |
| --- | --- |
| image upload (`save`, under the multipart threshold) | `HeadObject`, `PutObject` |
| file upload at or over the threshold (`save`) | `HeadObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload` |
| file upload whose part fails (`save`) | `HeadObject`, `CreateMultipartUpload`, `UploadPart`, `AbortMultipartUpload` |
| on-demand resized image (`saveRaw`) | `HeadObject`, `GetObject`, `PutObject` |
| hold release (`saveRaw` from this decorator) | `PutObject` |
| admin media inliner (`saveRaw`) | `HeadObject`, `PutObject` |
| oEmbed thumbnail and icon (`saveRaw`) | `PutObject` |
| same-name media thumbnail (`delete`, then `save`) | `HeadObject`, `PutObject` |

Every request is also checked for the properties the gateway relies on:
header-signed SigV4 with a signed payload hash, no presigned URL, no chunked
transfer or `aws-chunked` body, no trailing checksum, a content length on
every body, and a CRC32 checksum header on `PutObject` and `UploadPart`. The
AWS SDK adds an `x-id=<Operation>` query parameter to every request; it is
recorded but not used to classify, because a gateway judges method, path and
query alone.

No `DeleteObject` reaches the store: this decorator never forwards `delete()`,
and turns the same-name thumbnail's delete-then-save into an overwrite. A
gateway that allows only these seven shapes therefore fits.

When Ghost is bumped, the version check (`PINNED_GHOST_VERSION`) fails on
purpose. Read the shape tests' result first: if they pass the new version
still fits the gateway, and the constant and the docs that name the version
move together.
