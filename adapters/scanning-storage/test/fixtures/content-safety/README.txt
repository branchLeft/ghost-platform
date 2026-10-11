Contract fixture for the verdict key.

pdq-hash.ts is branchLeft/content-safety src/pdq-hash.ts, copied verbatim at
commit 48a1e79e810e361c1b04e7a0322f44372b833c9f, the module that decides
whether a value is a PDQ hash the hash source's request body will accept
(parsePdqHash). It is a copy, not an import: the package is not installable
from this repository's CI, and a test must not depend on a registry token.

Reproduce or refresh the copy, from a clone of branchLeft/content-safety:

  git fetch origin
  git show origin/main:src/pdq-hash.ts > pdq-hash.ts
  shasum -a 256 pdq-hash.ts

then update the pinned sha256 and commit in test/unit/content-safety-contract.test.mjs
and the `contentSafety.commit` field of recorded-hashes.json. The test fails if
the copy is edited by hand.

recorded-hashes.json is the base64 hash this adapter computes for each fixture
image (the reference images under ../pdq-reference/images and the two images the
adapter tests use) with the decoder version it names. A change here after a
decoder bump is the point of the file: review the distance to the old value
before accepting it, because the hash source's list was built from other decoders.
