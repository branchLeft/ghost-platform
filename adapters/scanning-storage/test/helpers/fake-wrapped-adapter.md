# fake-wrapped-adapter.mjs

## FakeWrappedAdapter

A test double standing in for a real Ghost storage adapter (local or S3).
Tracks every `save()`/`saveRaw()` as a tiny virtual filesystem (path ->
buffer), so `exists()`/`read()` answer from real state exactly as a real
adapter's would. The hold branch depends on that: nothing must be
observable through this adapter until something has actually written to
it — a canned true/false here would hide exactly the bug this decorator
exists to avoid.

`existsResult`/`readResult` in config still override the real-state answer
when a test wants to force one, independent of what has or hasn't been
written — used by tests about pure delegation, not about hold.
