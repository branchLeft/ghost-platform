# apply-patch.sh

## Usage

`apply-patch.sh DIR FILE PATCH PIN`

| Argument | Meaning |
|---|---|
| `DIR` | The directory holding Ghost's own file. |
| `FILE` | The file to patch, relative to `DIR`. |
| `PATCH` | Path to the unified diff (labelled `a/FILE` and `b/FILE`). |
| `PIN` | Path to a `sha256sum` line naming `FILE`: the hash of the file with the patch applied. |

## What it does

1. Applies `PATCH` to `DIR/FILE` in place, with no fuzz.
2. Checks the result against `PIN`.

It exits non-zero, with one of two messages on stderr, when the patch does not apply cleanly (upstream
changed the lines it touches) or when the patched file is not byte-for-byte the one the pin was taken from
(upstream changed the file somewhere the patch does not look). It needs `patch` and either `sha256sum` or
`shasum`.

## Who uses it

The root `Dockerfile`, for `adapters/sso/ghost-core-overlay` and `adapters/stripe-connect-limit/ghost-core-overlay`.
`adapters/sso/test/unit/global-setup.mjs` and the sso overlay's unit tests run it against Ghost's file extracted
from the same pinned image, so the rule that decides whether an overlay is still valid has one home.
