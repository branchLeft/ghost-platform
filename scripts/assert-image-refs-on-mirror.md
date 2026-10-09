# assert-image-refs-on-mirror.py

## What this gate checks

Every image this repo asks Docker to pull must be one of:

- `ghcr.io/branchleft/mirror/<name>@sha256:<digest>` where the name and digest
  pair is in `.github/image-mirror/images.json`;
- another `ghcr.io/branchleft/<name>@sha256:<digest>` (our own published image,
  pinned by digest);
- a local build tagged `:ci` or `:proof`, or any name built in the tree by
  `docker build -t`.

Everything else is a finding, and the kind says why: `unqualified` (no
registry, so it resolves to Docker Hub), `docker.io`, `other-registry`,
`tag-only` (a tag can move) or `not-on-list` (a mirror reference whose digest
is not mirrored, so it would 404).

## What it reads

Tracked files, except Markdown, vendored output and the list's own directory:

- `FROM` lines in `Dockerfile*` and `*.Dockerfile`;
- `image:` and `container:` values in YAML, which covers workflow `services:`;
- `*_IMAGE=` and `${*_IMAGE:-...}` assignments, and the first positional argument
  of `docker run`, `create` and `pull`, in shell and workflow `run:` bodies;
- in `.ts`, `.js`, `.mjs`, `.py` and `.json`, a quoted image-shaped string with a
  version-shaped tag or a digest, within a few lines of the words docker or image.

A reference built from a variable or expression (`$X`, `${{ ... }}`) is not
followed; the line that defines the variable is the one that is checked.

## Modes and the allowance

`--mode warn` prints every finding and exits 0. `--mode enforce` exits 1 on any.
CI runs the mode set in `GUARD_MODE` in `image-mirror-ci.yml`.

The only allowance is the `allow` section of the list: whole files, each with a
written reason, for test fixtures that fake docker or hold a rejected input and
never pull. A file that really pulls an image is never allowed; its reference is
rewritten to the mirror.

## Proof

`--self-test` builds throwaway trees and requires, in order, that a `FROM ghost:`
line, a tag-only mirror reference and an unqualified workflow service image each
produce exactly one finding, and that a clean tree produces none. The same
cases run through `--mode enforce` in `scripts/test_image_mirror.py`.
