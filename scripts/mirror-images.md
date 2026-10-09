# mirror-images.py

## What it does

Docker Hub rate-limits anonymous pulls per runner address, so CI and the hosts
must not pull third-party images from it. This script copies each image in
`.github/image-mirror/images.json` to `ghcr.io/branchleft/mirror/<name>` by
digest and proves the copy.

For each entry it:

1. asks the mirror for the tag `d-<first 12 hex of the digest>`; if that
   already resolves to the listed digest, the copy is skipped (idempotent);
2. otherwise runs `crane copy <source>@<digest> <mirror>/<name>:<tag>`, with up
   to three attempts and a growing pause, because the source is rate-limited;
3. fetches `<mirror>/<name>@<digest>` and checks the SHA-256 of the manifest
   bytes equals the listed digest. A mirror that serves other bytes, or
   nothing, fails the entry.

Exit 0 only if every entry verified. `--dry-run` prints the commands and runs
none; `--only <name>` limits the run to one package.

## The list

`images.json` holds one entry per image digest: the source registry path (no
tag, no digest), the pinned digest, the upstream tags it was resolved from, the
mirror package name, and the upstream licence with where it was read. An entry
is a digest, never a moving tag; adding an image is adding an entry with the
digest read from the source at that moment. The reference guard
(`assert-image-refs-on-mirror.md`) reads the same file.

## Authority

The workflow runs it with the run's own `GITHUB_TOKEN` and `packages: write`.
Nothing here logs in to Docker Hub or reads a stored secret. A copy from a
developer machine is not part of the design.

## Tests

`scripts/test_image_mirror.py` runs the copy logic against a recording fake of
`crane`: the copy-then-verify order, the idempotent skip, a tag pointing at
another digest, a read-back mismatch, a missing mirror, retry and give-up, and
the list's validation.
