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
and an in-process `VerdictClient` test double. It does **not** build:

- **The real verdict channel.** The safety service that checks a hash
  against a known-material database lives in a separate repo, built by a
  separate story, per the platform owner's own ruling that it should be
  extensible to other organisations later. `ScanningStorageAdapter.js`
  constructs a `FakeVerdictClient` from its own config until that story
  lands; nothing here guesses that channel's wire format or transport.
- **The hold branch.** When a verdict channel times out or is
  unreachable, the high-level design's own ruling is to accept the upload and
  hold the bytes unserved until a verdict arrives, never to refuse. The
  in-process fake verdict client is always reachable and always synchronous,
  so this branch is never exercised through it, and this decorator has no
  promote-on-clean-verdict mechanism. `Policy.decide` can still return
  `'hold'` (or `'flag'`, for the advisory/text route), and the adapter fails
  loudly rather than guessing a behaviour if it ever sees one.
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

The same four keys apply under `storage__media__*` and `storage__files__*`.
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
