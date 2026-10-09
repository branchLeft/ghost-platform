# mirror-images.py

## What it does

Docker Hub rate-limits anonymous pulls per runner address, so this repo's CI
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

## Visibility

The mirror packages stay **private**, GitHub's default. The reason is Docker's
Terms of Use (https://www.docker.com/legal/docker-terms-service/, effective
2026-08-26), which say users "may redistribute Docker Images made available in
Docker Hub at no cost, to third parties but solely when bundled with or
incorporated into its own software products, and not on a standalone basis",
and that other parties' images are "Third-Party Content subject to their
corresponding terms and conditions". A public package of unmodified Docker Hub
images is standalone redistribution, so the copy is kept private and used only
by this repository's own workflows.

The consumers are this repository's workflows, pulling with `GITHUB_TOKEN`
(`packages: read`) after a `docker login ghcr.io`. Hosts are not consumers:
host stacks keep their Docker Hub references until the owner decides how a host
would hold a pull credential. The upstream licences recorded in `images.json`
are checked for this private CI copy only.

## Local development (no credential)

A private mirror must not make local work harder: an agent or the owner
building or testing on a laptop has no GHCR credential and needs none. Every
image reference therefore keeps the same digest and takes only its registry from
one variable whose default is the public source:

- Dockerfile: `ARG IMAGE_REGISTRY` then
  `FROM ${IMAGE_REGISTRY:-docker.io/library}/caddy:2-alpine@sha256:<digest>`;
- scripts and compose: `${IMAGE_REGISTRY:-docker.io/library}/node:26.5.0-bookworm-slim@sha256:<digest>`,
  the namespace being whatever the image's public source is (`docker.io/percona`,
  `ghcr.io/letsencrypt`, and so on).

With `IMAGE_REGISTRY` unset, which is every local run, Docker pulls the public
image by that digest. In CI the workflow sets
`IMAGE_REGISTRY=ghcr.io/branchleft/mirror` (after a `docker login ghcr.io` with
`GITHUB_TOKEN`), the same reference resolves to the mirror copy, and the digest
guarantees the same bytes. A `docker build` takes the value from
`--build-arg IMAGE_REGISTRY`, which reads it from the environment. The mirror
package name is the last path component of the source, so the same tail works
for both. `assert-image-refs-on-mirror.md` says how the guard enforces it.
