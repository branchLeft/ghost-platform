# assert-image-refs-on-mirror.py

## What the guard reports

The guard reads the tracked files and reports every image reference that is
not in one of these forms:

- `${IMAGE_REGISTRY:-<public namespace>}/<name>:<tag>@sha256:<digest>`, where
  `<public namespace>/<name>` is the public source of that digest in
  `.github/image-mirror/images.json`. With `IMAGE_REGISTRY` unset (every local
  build) Docker pulls the public image by digest with no credential. CI sets
  `IMAGE_REGISTRY=ghcr.io/branchleft/mirror`, which selects the mirror copy of
  the same digest. The default is inline, not one shared variable, because each
  image has its own public namespace.
- `ghcr.io/branchleft/<name>:<tag>@sha256:<digest>`, an image this repo publishes,
  pinned by digest.
- a name and tag that this tree builds itself with `docker build -t`, used
  without a digest (see Exemptions).

A reference that passes needs a tag as well as a digest. The guard does not check
that a digest exists upstream: a digest is checked for its shape and, in the
variable form, against the list.

## Finding kinds

- `unqualified`: no registry host (`ghost:6`); Docker resolves it to Docker Hub's
  library namespace.
- `docker.io`: a Docker Hub reference with a namespace (`percona/percona-server`),
  or an explicit `docker.io`, `registry-1.docker.io` or `index.docker.io` host.
- `other-registry`: any other registry host, including a host given as an IP
  address or with a port, and a `ghcr.io` path outside `branchleft/`.
- `tag-only`: a reference with no digest, with or without a tag.
- `no-tag`: a digest with no tag. The form requires `<name>:<tag>@sha256:<digest>`.
- `hard-coded-mirror`: a literal `ghcr.io/branchleft/mirror/...` reference, which
  would break a local build because it has no public default.
- `bad-default`: a variable form that is malformed, or whose default is not the
  public source of the digest on the list.
- `bad-override`: a workflow sets `IMAGE_REGISTRY` to anything other than
  `ghcr.io/branchleft/mirror`.
- `override-no-permission`: a workflow sets `IMAGE_REGISTRY` to the mirror without
  `packages: read` (or `write`, or `read-all`/`write-all`) at workflow level or in
  the job that sets it. A comment does not grant it.
- `UNRESOLVED`: a reference whose value is not in the repo, so the guard cannot
  say what it pulls. See the next section.

## Exemptions

- A local build exempts only the exact `name:tag`, with no digest, that a file in
  the tree builds with `docker build -t` (or `--tag`), and only when that name has
  no registry host. `quay.io/x:1` built in the tree is still `other-registry`.
  An unbuilt `:ci` or `:proof` tag is not exempt.
- `allow` in `images.json` skips whole files, each with a written reason. It is
  for files that name an image without pulling it in CI: test fixtures that fake
  Docker or hold a rejected input, golden output of the renderer, the renderer's
  own template (`render-core/src/compose.ts`), and the widgets pin record and the
  script that writes it. A file that pulls an image in CI is not allowed; its
  reference is rewritten.
  One allowed file, `control/provision/test_nextcloud_backup.py`, also holds an
  opt-in `docker run` of an image that is not on the list; its reason says so,
  and CI does not set the variable that enables it.
- Skipped by design: directories named `dist`, `forks`, `node_modules`,
  `graphify-out`, `.standards` and `.git`, at any depth; the list's own directory
  (`.github/image-mirror/`); Markdown, SQL, lock files, images, fonts and archives,
  by suffix; any file over 1 MB or not UTF-8 text. `bin/` is scanned.

## What it reads

Tracked files only (`git ls-files`). Each bullet ends with the claim ids it makes.
`ClaimsTableTests` in `scripts/test_image_mirror.py` holds one minimal
construction per id and requires the guard to report it, and it fails on a bullet
with no id and on an id with no row. A claim cannot be written here without a
construction the guard is shown to meet.

- `FROM`, `COPY --from` and `RUN --mount ... from=` in Dockerfiles and
  `Containerfile`s. `ARG` and `ENV` values are followed into those lines, and
  backslash continuation lines are joined. A leading byte order mark is ignored.
  [claim: dockerfile-from, dockerfile-copy-from, dockerfile-run-mount,
  dockerfile-arg-env, dockerfile-continuation, dockerfile-bom]
- The `# syntax=<image>` parser directive of a Dockerfile (see Syntax directive).
  [claim: dockerfile-syntax]
- YAML: `image:` and `container:` (including workflow `services:`), `*_IMAGE:`,
  `*_TAG:`, anchors and aliases, flow style, `uses: docker://` and
  `image: docker://`.
  [claim: yaml-image, yaml-container, yaml-env-keys, yaml-tag-keys, yaml-anchors,
  yaml-flow, yaml-docker-uri]
- Assignments in shell, `.env`, TOML and other text files: `IMAGE=`, `*_IMAGE=` and
  `*_TAG=` (including `echo "IMAGE=..." >> $GITHUB_ENV`), and in a Makefile the
  same names with `=`, `?=`, `:=`, `::=` or `+=`. A Makefile variable (`$(IMAGE)`)
  is followed like a shell one. Uppercase names only: `foo_image =` is not read.
  [claim: assign-image, assign-suffix, assign-tag, make-assign]
- A bare name on an image key (`image: foo`) is reported only when it looks like an
  image: it has a `:`, `@` or `/`, or it is a well-known image name, or it is the
  last component of a listed source.
  [claim: bare-name]
- The first image operand of `docker`, `podman` or `nerdctl` `run`, `create` and
  `pull`. `docker compose pull` names no image and is not a finding. The operand
  is found past options, and past a flag's value that is a command substitution
  with spaces (`-u $(id -u):$(id -g)`, `--name x-$(date +%s)`, `$(shell id -u)`),
  a backtick pair, or a redirect (`2>/dev/null`).
  [claim: docker-verbs, docker-runtimes, operand-substitution, operand-redirect]
- The docker word is read where it is a command: at the start of a line, and after
  `;`, `&&`, `||`, `|`, `(`, a backtick or `$(`; after `then`, `do`, `else`,
  `elif`, `if`, `until`, `while`, `sudo`, `exec`, `time`, `eval`, `command`,
  `nohup`, `xargs`, `env`, `timeout`, `retry`, `nice`, `ionice` or `watch`; after
  those with their options, a duration or count, and `FOO=1` or `FOO="a b"`
  assignments; after a YAML `run:` or `command:` key, with or without assignments
  and with the scalar plain or quoted, and in a `run: |` block; inside a quoted
  `sh -c`, `bash -c`, `bash -lc`, `sh -ec`, `eval` string, a string assigned to a
  shell variable (`CMD="docker run ..."`), or after `ssh [options] host` quoted or
  not; as a case arm (`a) docker run ...`, with or without an assignment); after
  a Makefile recipe's `@`, `-` or `+`, and inside `$(shell ...)`. It may be a path
  (`/usr/bin/docker`) or a variable (`$DOCKER`, `${DOCKER}`, `$(DOCKER)`).
  [claim: command-line-start, command-separators, command-words,
  command-wrapper-options, command-yaml-keys, command-yaml-quoted,
  command-quoted, command-ssh, command-forms, command-case-arm,
  makefile-recipe]
- Build inputs that are images: `--build-context name=docker-image://<ref>` and
  `build-contexts:` values, `--cache-from type=registry,ref=<ref>` and
  `--cache-from <ref>`, and `--build-arg NAME=<ref>`. A build argument whose name
  holds `IMAGE`, `BASE`, `REPO`, `REGISTRY` or `FROM` and whose value is built
  from a variable (`BASE=${REG}/node:20`) is reported UNRESOLVED.
  [claim: build-context, cache-from, build-arg]
- Code (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`,
  `.json`): a quoted image-shaped string with a version-shaped tag or a digest,
  when a docker or image word is within twelve lines before it, or when its name
  is a well-known image or a listed one; and a command string passed to docker.
  [claim: code-strings, code-command-string]

## Syntax directive

A Dockerfile that begins `# syntax=docker/dockerfile:1` makes BuildKit pull that
frontend image from Docker Hub at build time, by a moving tag with no digest. The
guard reports it like any reference (`docker.io` for the form above), at the
directive's line. The list holds a row for `docker/dockerfile:1`, so the image can
be mirrored. A directive cannot hold a variable, so it cannot be written in the
`${IMAGE_REGISTRY:-...}` form. Converting it is a choice between pinning it by
digest on Docker Hub (still reported as `docker.io`), pointing it at the mirror
path (which breaks a build with no credential), and removing the directive, after
which the builder uses the frontend built into it. Removal is not free: six of the
seven Dockerfiles use `RUN --mount=type=secret`, and three carry a comment saying
the directive is there to guarantee that frontend feature rather than leave it to
whichever frontend the local daemon bundles. That choice is PR B's, and is not
made here.

## UNRESOLVED

A reference built from a value that is not in the repo cannot be followed. The
guard reports it at its line and does not accept it. Examples the tree produces:
script arguments (`$1`, `${1:?usage ...}`), workflow expressions such as
`${{ steps.<id>.outputs.<name> }}` and `${{ matrix.<name> }}`, and a variable with
no definition anywhere in the tree. A variable with a default (`${X:-y}`) is
followed to its default. A first operand of `docker run` that is not shaped like
an image and holds `=`, `/` or a space (the value of a flag the guard does not
know, such as `--ulimit nofile=1024:2048`) is reported the same way, because the
image may be behind it. Enforce mode fails on any UNRESOLVED reference.

## Modes

- `--mode warn` prints every finding and exits 0. It exits 2 when the list cannot
  be read. The self-test exits 1 when a case fails.
- `--mode enforce` exits 1 on any finding, UNRESOLVED included.
- CI runs the mode named by `GUARD_MODE` in `image-mirror-ci.yml`.
- What a missed reference costs differs by mode. In warn mode nothing breaks: the
  reference is absent from the inventory and keeps pulling from Docker Hub, as it
  does today. In enforce mode the same miss gives false confidence, because the
  run is green. See the first sentence of Limits.

## Limits

**The guard reads exactly the forms listed under What it reads. Any other spelling
is not read, and a reference there is not reported: a green enforce run proves only
that no listed form was found.** The list below names the silent classes known at
this head. It is not exhaustive, and a spelling absent from both lists is not
promised either way.

- The guard is static. An image chosen at run time (a computed name, a value from
  a file that is not tracked, an input) is seen only where its text is in the
  repo, and then as UNRESOLVED or not at all.
- The image operand of `docker run` is the first word after the verb that is not
  a flag or a value of a listed flag. A flag that is not on the list and takes a
  bare number is read past. One that takes a `key=value`, a path or a quoted
  phrase makes that word the operand, and it is reported UNRESOLVED
  (`--device-cgroup-rule 'c 42:* rmw'`); so is a plain word, with or without `,`,
  `+`, `@` or `!`, when an image-shaped word follows it. A plain word with no
  image after it is taken as prose and ignored.
- The docker word is not read after a wrapper that is not listed under What it
  reads (`flock`, `stdbuf`, `parallel`, a function of your own such as
  `on_host "docker run ..."`), when the command is held in a variable or a make
  macro (`$(DOCKER_RUN) alpine:3`), or after a prose word.
- Quoted strings in code are read only near a docker or image word (twelve lines
  before), or when the name is well known or listed, and only when they look like
  an image. Image names built by concatenation are not followed.
- Other tools (`buildah`, `kaniko`, `skopeo`, `crane`, `kind load`) and client
  libraries are not read, nor are `docker manifest inspect`, `buildx imagetools`
  and `docker save`. A client-library call that splits the name from the tag
  (`images.pull('mysql', tag='8.0')`), `python -c` with the Docker SDK, a
  container-library constructor with no docker word near it (`GenericContainer`)
  and a pull whose image is a variable in another file are not read.
- Formats not read at all, because the doc claims none of them: Go, Ruby and other
  source files that are not listed under Code; a YAML `cmd: [docker, run, ...]`
  argv list; Terraform `docker_image`; a Jenkinsfile; a `from:` key; a Cloud Build
  `name:` builder; an unanchored `x-images:` map a tool consumes; lowercase
  `foo_image` keys in TOML or `.env`; a package script in `package.json` that is
  not a command string passed to docker.
- Not read, and so not reported: compose `build.args` and a
  `docker/build-push-action` `build-args:` block that override a pinned `ARG`
  default; a `cache-from:` or `cache_from:` key that holds a bare reference; a
  Bake file's `args` and `dockerfile-inline`; a compose `dockerfile_inline`;
  Kustomize `images:` with `newName:`; Helm-style `repository:` and `tag:` keys
  written as two values; Podman quadlet `Image=`; a Dockerfile written out by a
  heredoc, `printf` or `echo`; a `run: >` folded scalar that splits `docker run`
  from its image across lines; and a Dockerfile whose name is not `Dockerfile*`,
  `Containerfile*`, `*.Dockerfile` or `*.Containerfile`.
- An image that a build pulls through a base image held in another repository is
  not visible.
- A clean run does not show that a pull does not happen. It shows that each
  reference the guard reads has one of the forms above.
- The guard does not check mirror contents. `scripts/mirror-images.py` copies
  each listed digest and reads it back.

## Proof

`--self-test` builds throwaway trees, one for each construction a finding kind
covers, and requires each to produce exactly its expected finding; a clean tree
must produce none. The same constructions run through `--mode enforce` in
`scripts/test_image_mirror.py`, whose test names are the list of cases.
