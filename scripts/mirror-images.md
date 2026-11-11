# mirror-images.py

## What it does

Docker Hub rate-limits anonymous pulls per runner address, so this repo's CI
must not pull third-party images from it. This script copies each image in
`.github/image-mirror/images.json` to `ghcr.io/branchleft/mirror-private/<name>`
by digest and proves the copy.

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

The mirror packages are **private**. Reason (PRIN-1): the images are other parties' works under licences that set conditions on a public copy (the corresponding-source offer for the GPL-2.0 code in the mysql and percona-server images, notices and terms for the debian, alpine, pebble and AGPL-3.0 zitadel entries, and Docker's terms on standalone redistribution of Docker Hub images). Nothing in this repository meets those conditions, and `images.json` flags those entries `conditioned`. The private copy is for this organisation's own workflows and hosts. Secrecy is not the reason: the images are public upstream. A workflow cannot change a package's visibility; a first publish is private, and a public package cannot be made private again.

Build artifacts, mirror copies and derived images alike, are private unless publishing one benefits the open-source community. This is a default for artifacts, not a rule about source, which stays public by default. The owner's words: "we are open-source first, source-available second. We don't need to make our build artifacts public unless they are beneficial to the open-source community."

The packages under the retired namespace `ghcr.io/branchleft/mirror/` were published public before this move and are not changed by this repository. They are not used by any reference in the tree.

A fork of this public repository belongs to a third party, and GitHub's package documentation says that granting a public repository access to a private package can let its forks, and Dependabot, read it. Whether that applies to these packages has not been observed. It is not recorded as an accepted risk in `.claude/ACCEPTED-RISKS.md`. Whether to accept it, or to require it to be observed on the first run first, is the owner's decision; this change does not make it.

The consumers are this repository's workflows, pulling with `GITHUB_TOKEN` (`packages: read`) after a `docker login ghcr.io`. Nothing is pulled anonymously. Hosts are not consumers in this change: host stacks keep their Docker Hub references until a later change gives each pulling host its own read-only key through `DOCKER_CONFIG`. The upstream licences recorded in `images.json` are checked for this private copy only.

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
`IMAGE_REGISTRY=ghcr.io/branchleft/mirror-private` (after a `docker login ghcr.io` with
`GITHUB_TOKEN`), the same reference resolves to the mirror copy, and the digest
guarantees the same bytes. A `docker build` takes the value from
`--build-arg IMAGE_REGISTRY`, which reads it from the environment. The mirror
package name is the last path component of the source, so the same tail works
for both. `assert-image-refs-on-mirror.md` says how the guard enforces it.
