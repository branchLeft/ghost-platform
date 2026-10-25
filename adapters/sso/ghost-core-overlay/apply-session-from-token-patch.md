# apply-session-from-token-patch.sh

## Usage

`apply-session-from-token-patch.sh DIR`, where `DIR` holds Ghost's own `session-from-token.js`.

## What it does

1. Applies `session-from-token.patch` (beside the script) to `DIR/session-from-token.js` in place, with no fuzz.
2. Checks the result against `session-from-token.patched.sha256` (beside the script).

It exits non-zero, with one of two messages on stderr, when the patch does not apply cleanly or when the
patched file is not byte-for-byte the one the pin was taken from. The second case is what catches a Ghost
change outside the lines the patch touches: the patch can still apply while the file around it has changed.

## Why one script

The root `Dockerfile` runs it against the file in the digest-pinned Ghost image, and
`test/unit/global-setup.mjs` runs it against the same file extracted from that image, so the rule that decides
whether the overlay is still valid has one home. It needs `patch` and either `sha256sum` or `shasum`; the image
build installs `patch` for the one layer and removes it.
