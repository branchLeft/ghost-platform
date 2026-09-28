# version.ts

## Intended version

The Ghost version a descriptor *intends*, read from `descriptor.image`
rather than stored a second time. `image` is pinned by digest
(`brand.ts#validateDigestPinnedRef`); the optional human-readable tag beside
the digest — kept, per that validator's own comment, "for a human reading
the ref" — is the only place a Ghost version appears anywhere in this
schema. This value is needed for one purpose only: comparing it against
what a running Ghost instance reports about itself. That "reported" half
never comes from here — the reported version comes from the instance,
never from our own records — so this module knows nothing about probing
anything live.
