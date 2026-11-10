# resolve-mirror-entry.py

## What it does

Reads the mirror list (`.github/image-mirror/images.json`) and prints the one
image a workflow is to sign, as two lines for `$GITHUB_OUTPUT`:

```
image=ghcr.io/branchleft/mirror/<name>
digest=sha256:<64 hex>
```

The entry is chosen by package name and by an upstream tag it lists, for
example `mysql` and `8.0.46`. Exactly one entry must match: none, or two, exit 1
and print nothing. A list that fails the mirror script's own validation exits 2.

## Why it exists

The digest of a third-party image is pinned in one place, the mirror list. The
workflow that signs the image (`mysql-image-attest.yml`) reads the digest from
here instead of holding its own copy, so a bump of the pin is one reviewed edit
to the list and cannot leave the signed digest behind the mirrored one.

The list is loaded with `load_list` from `mirror-images.py`, so a malformed
entry is refused by the same code that copies it.

## Tests

`scripts/test_resolve_mirror_entry.py`: the match, a tag on another name, two
matches, a bad list, and the committed list resolving `mysql` 8.0.46.
