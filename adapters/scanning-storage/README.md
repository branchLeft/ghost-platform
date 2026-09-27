# Scanning storage decorator

Wraps whatever storage adapter Ghost is configured with -- local disk or S3 --
and refuses a known-bad upload before it ever reaches the wrapped adapter.
Design: `ghost-platform-docs/19-try-it-now-design/07-safety-toolbox.html`
(LLD-7), including its dated amendments (D34, D43, D55), and
`90-cross-document-review.html` (G2, P2).

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
an in-process `VerdictClient` test double, and the hold/promote mechanism
(D34) that accepts an upload with no verdict and serves nothing until
one arrives. It does **not** build:

- **The real verdict channel.** The safety service that Arachnid-checks a
  hash lives in a separate repo, built by a separate story (owner ruling:
  workspace#1266). `ScanningStorageAdapter.js` constructs a `FakeVerdictClient`
  from its own config until that story lands; nothing here guesses that
  channel's wire format or transport. Because there is no real channel, "a
  later verdict arrives" can only mean one thing this decorator can observe:
  the same in-process `VerdictClient` answering differently on a later call
  (`src/hold.js` polls for that). `Policy.decide` can still return `'flag'`,
  for the advisory/text route, and the adapter fails loudly rather than
  guessing a behaviour if it ever sees one.
- **A behaviour for video (`storage:media`) or arbitrary files
  (`storage:files`).** PDQ is an image hash; the design names video as
  undesigned (issue's own open question, deferred to Rob via
  workspace#1151/#1200). The decorator class wraps any of the three storage
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

## Configuration

Ghost config, normally set as environment variables on the tenant's
container, one block per storage feature (`images`, `media`, `files`):

| Env var | Meaning |
|---|---|
| `storage__images__adapter=ScanningStorageAdapter` | Selects this decorator for the `storage:images` feature. |
| `storage__images__wraps=LocalImagesStorage` | The adapter class this decorator wraps, resolved from the same directory Ghost's own adapter manager resolves any adapter from -- `LocalImagesStorage`, `LocalMediaStorage`, `LocalFilesStorage` or `S3Storage`. |
| `storage__images__wrappedConfig__*` | Passed straight through to the wrapped adapter's own constructor (e.g. `storage__images__wrappedConfig__bucket` for `S3Storage`). `LocalImagesStorage`/`LocalMediaStorage`/`LocalFilesStorage` ignore it; they always self-configure from Ghost's own `getContentPath`. |
| `storage__images__quarantinePath` | Where a refused upload's bytes are written, named by digest. Always local disk, regardless of which adapter is wrapped -- quarantine is never the served location. |
| `storage__images__refuse` | A JSON object of `digest -> {classification, matchType}`, seeding the in-process fake verdict client. Empty or unset refuses nothing. |
| `storage__images__unavailable` | A JSON array of digests the fake verdict client answers `'unavailable'` for, until told otherwise -- proves D34's hold branch, with no real channel to simulate an outage or a timeout through. Empty or unset holds nothing. |
| `storage__images__resolvePath` | A directory the fake verdict client polls for `<digest>.json` files, letting an image-test driver in a separate process "deliver" a verdict for a held digest by writing one. Never used outside the image-test harness. |
| `storage__images__holdRetryMs` | How often a held digest is re-asked. Incidental, like the verdict budget in `checks.js` -- defaults to 2 seconds. |

The same seven keys apply under `storage__media__*` and `storage__files__*`.
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
ships `blocking: true`; its hash primitive is injected (`src/pdq.js`'s
`digestBytes`, a SHA-256 stand-in -- PDQ itself is incidental to this design
and proving near-duplicate matching is the verdict channel's job, not this
decorator's).

### The hold branch (D34)

A `'hold'` decision never throws: the upload is accepted and returns a URL,
and `src/hold.js` polls the same checks against the held digest until a
definitive answer arrives -- there being no real channel, that is the only
way "later" can mean anything here. `'allow'` promotes; `'refuse'` moves it
to quarantine permanently, exactly as a synchronous match would, with no one
left waiting to hear about it. A digest that never resolves stays held
forever; nothing here ever decides to serve on a stale or absent verdict.

The mechanism differs by backend, because unlike a bucket, this adapter is
still consulted on every read of local disk:

- **Local** (`storage__*__wraps=Local*Storage`): the real bytes are written
  through the wrapped adapter immediately, and `exists()`/`read()`/`serve()`
  withhold them from every caller until promoted -- a real, adapter-correct
  URL for free, at the cost of masking every read while held. Promoting is
  then only ever lifting the mask; a later refuse deletes the real copy
  too, so nothing lingers, masked, in the served tree.
- **Object storage** (`wrappedConfig.bucket` set -- `S3Storage`'s shape): the
  wrapped adapter is never asked to write until promotion. This decorator
  computes the eventual target itself, named by digest rather than through
  the wrapped adapter's own `getUniqueFileName`, because two different held
  uploads sharing an original filename would otherwise both compute as free
  and collide on promotion. The URL is built from the same `wrappedConfig`
  the real adapter was constructed with (`cdnUrl`, or `endpoint` + `bucket`).

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
   tier runs `S3Storage` (D55); a subclass of the local adapter is not in
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

The same file also proves the hold branch (D34) on both tiers, with the
verdict client configured to never answer (`storage__images__unavailable`):
an upload still returns 201 and a URL; that URL, an on-demand size request
for it, and -- on the object-storage tier -- a direct read of the bucket key
all return nothing; and a held object that never clears is never served (the
control case). Delivering a clean verdict from the test driver, a separate
process from the container, uses `storage__images__resolvePath` (see
`src/verdict-client.js`'s own comment) rather than anything that guesses the
real channel's wire format.
