# RUNBOOK: the broker's deployment on demo1

Scope: this file covers only `services/broker`'s own install and upgrade on
the demo host, once that host exists. It does not cover:

- bringing demo1 up at all (branchLeft/workspace#1188, open);
- the per-colour systemd unit the wrapper starts and stops, or the uid/dir
  claim records for each slot (branchLeft/workspace#1448, #1447, both open
  and both named by branchLeft/workspace#1545 as blocking demo1 alongside
  this one);
- the demo host's Pulumi stack or firewall (a separate story).

A step below that depends on one of those lands as a named gap, not a
worked step -- see "Left out, deliberately" at the end.

## Runtime: a bundled single file, not a plain `pnpm install --frozen-lockfile` on the host

`services/broker/package.json` depends on
`@branchleft/ghost-platform-render-core` via `file:../../render-core`.
Installed locally (`pnpm install --frozen-lockfile` in this checkout), that resolves to a symlink
four directories up (`node_modules/@branchleft/ghost-platform-render-core
-> ../../../../render-core`) -- proven by running it, not assumed. render-
core's own `package.json` says why a normal host install can't lean on the
registry instead: "to be published the same way ... no publish workflow
exists for it yet" (`CLAUDE.md`). A host install would therefore need the
whole monorepo checkout staged at that exact relative layout, which is
fragile to rsync and easy to let drift from what actually shipped.

Instead, `pnpm run bundle` (`esbuild.bundle.mjs`) produces five self-
contained ESM files with render-core (and this package's own modules)
inlined:

- `dist/bundle/broker.mjs` -- the one entrypoint Node runs.
- `dist/bundle/plugins/renderCorePlugin.mjs` -- the real `Renderer` seam.
- `dist/bundle/plugins/dockerImageLoader.mjs` -- the real `ImageLoader`
  seam.
- `dist/bundle/plugins/refusingDrainSource.mjs` -- the final `DrainSource`
  seam: it refuses every poll, because mail is collected from the mail
  queue directly and nothing is handed over through the broker.
- `dist/bundle/plugins/ghostAdminApi.mjs` -- the real `AdminApiClient`. On a
  demo's first build it creates the owner account with a random password
  held only in memory, keeps only that owner's staff access token in the
  slot's private folder under `BROKER_ADMIN_KEY_DIR`, and applies the code
  injection and members support address settings with it. Later builds
  (colour swaps, retries) re-apply them with the stored token. If the
  prospect regenerates the token in their Ghost profile, the next swap is
  refused and the demo stays on its current colour. A reset deletes the
  token. See `src/ghostAdmin/client.md`.

Each file has no `node_modules` dependency once built: `server.ts#loadPlugin`
reaches the plugin modules through a runtime `import()` of an environment
variable's value, which esbuild cannot inline through, so they are bundled
as separate entrypoints rather than folded into `broker.mjs` itself.

Node itself is a pinned source, not bundled: this package's own `.nvmrc`
(`v26.5.0`) is the version to install, matching what CI and every
contributor's checkout already use.

## Install (first boot)

Run from the root of a ghost-platform workstation checkout with SSH access to
demo1 -- an operator step; nothing here runs from CI (`services/broker/**`'s
`.claude/delivery-paths.json` row is `not_merge_delivered`/`version_pin`,
because no publish path exists yet either -- see "Delivery path" below).

**Pin the commit first.** This install comes from one ghost-platform commit,
named here and nowhere else in this runbook: the commit demo1 runs today
(release `1dbed88-20261011T105328Z`, built from the same commit as
`ghost-platform-docs/demo1-host-build-and-broker-runbook.md`). Check it out
before step 4, and stop if the check fails:

```bash
BROKER_PIN_COMMIT=1dbed8818e31a788f8d53b1399b69bdb57dc39b4
git fetch origin && git checkout --detach "${BROKER_PIN_COMMIT}" && test "$(git rev-parse HEAD)" = "${BROKER_PIN_COMMIT}"
```

To move to a later commit, change that one line and redo the check; step 4
then builds from whatever is checked out.

**Reach demo1 first.** Every `ssh` and `rsync` below uses `${DEMO1_IPV4}` and
`${DEMO1_SSH_USER}`; set them once per terminal, each in its own paste. demo1
is in the `branchLeft demos` Hetzner project, so the hcloud context must be that
project's. List the contexts, then read the name of that project's context:

```bash
hcloud context list
```

```bash
read -r HCLOUD_CONTEXT
```

```bash
hcloud context use "${HCLOUD_CONTEXT}"
```

```bash
DEMO1_IPV4=$(hcloud server ip demo1)
```

The login name is the `User` the old `demo1` alias carried in your
`~/.ssh/config`; read it:

```bash
read -r DEMO1_SSH_USER
```

The key is `~/.ssh/id_ed25519_hetzner`, as in `shared-infra/hetzner/RUNBOOK-edge.md`.

1. **Pin Node.** On demo1 -- `dpkg`'s architecture name and nodejs.org's own
   tarball name disagree (`amd64` vs. `x64`), and the tarball is verified
   against Node's own published checksums before it is ever extracted:

   ```bash
   case "$(dpkg --print-architecture)" in
     amd64) NODE_ARCH=x64 ;;
     arm64) NODE_ARCH=arm64 ;;
     *) echo "unsupported dpkg architecture: $(dpkg --print-architecture)" >&2; exit 1 ;;
   esac
   curl -fsSLO "https://nodejs.org/dist/v26.5.0/node-v26.5.0-linux-${NODE_ARCH}.tar.xz"
   curl -fsSLO "https://nodejs.org/dist/v26.5.0/SHASUMS256.txt"
   grep " node-v26.5.0-linux-${NODE_ARCH}.tar.xz\$" SHASUMS256.txt | sha256sum -c -
   sudo mkdir -p /opt/branchleft/broker/node
   sudo tar -xJf "node-v26.5.0-linux-${NODE_ARCH}.tar.xz" --strip-components=1 -C /opt/branchleft/broker/node
   rm "node-v26.5.0-linux-${NODE_ARCH}.tar.xz" SHASUMS256.txt
   /opt/branchleft/broker/node/bin/node --version   # expect v26.5.0
   ```

   Installed once per Node version, independent of the app's own release
   directory below -- an app upgrade that does not also bump `.nvmrc` never
   touches this step.

2. **Create the `broker` account**, if the host build hasn't already
   (branchLeft/workspace#1188/#1447 own the host's user/uid plan; this is
   the minimal fallback if it hasn't landed yet):

   ```bash
   sudo useradd --system --home-dir /var/lib/branchleft-broker --shell /usr/sbin/nologin broker
   ```

3. **Install the sudoers boundary and the wrapper**, if not already done by
   the host build:

   ```bash
   sudo python3 demo-host/provision/render_slot_sudoers.py --install /etc/sudoers.d/branchleft-slot
   sudo install -o root -g root -m 0755 demo-host/provision/branchleft_slot.py /usr/local/sbin/branchleft-slot
   ```

4. **Build and ship the bundle**, from a workstation checkout:

   ```bash
   cd services/broker
   pnpm install --frozen-lockfile
   pnpm run bundle
   ssh -i ~/.ssh/id_ed25519_hetzner "${DEMO1_SSH_USER}@${DEMO1_IPV4}" 'sudo mkdir -p /opt/branchleft/broker/releases'
   RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"
   rsync -a --chown=root:root -e 'ssh -i ~/.ssh/id_ed25519_hetzner' dist/bundle/ "${DEMO1_SSH_USER}@${DEMO1_IPV4}:/tmp/broker-release-${RELEASE}/"
   ssh -i ~/.ssh/id_ed25519_hetzner "${DEMO1_SSH_USER}@${DEMO1_IPV4}" "sudo mv /tmp/broker-release-${RELEASE} /opt/branchleft/broker/releases/${RELEASE} && sudo ln -sfn /opt/branchleft/broker/releases/${RELEASE} /opt/branchleft/broker/current"
   ```

   `rsync -a` preserves the workstation's own uid/mode bits, so the `mv`
   step keeps everything under `releases/` root-owned regardless of what
   the operator's own account looked like at the source end -- the
   `--chown` flag on the rsync step above pins that explicitly rather than
   relying on the destination `mv` alone.

5. **Create the directories the unit's `ReadWritePaths=`/`ReadOnlyPaths=`
   expect to already exist** -- a missing path here fails the unit with
   `226/NAMESPACE` at start, not at install:

   ```bash
   sudo mkdir -p /etc/branchleft
   sudo mkdir -p /var/lib/docker/volumes
   sudo install -d -o root -g root -m 0755 /var/lib/branchleft
   sudo install -d -o broker -g broker -m 0755 /var/lib/branchleft/broker-slots
   sudo install -d -o broker -g broker -m 0700 /var/lib/branchleft/broker-slots/admin-keys
   ```

6. **Write `/etc/branchleft/broker.env`** on demo1 from
   `systemd/broker.env.example`, root:root, mode 0600. The create runs only
   when the file is absent, so a re-run leaves a filled file untouched:

   ```bash
   if [ ! -e /etc/branchleft/broker.env ]; then
     sudo install -o root -g root -m 0600 /dev/null /etc/branchleft/broker.env
   fi
   sudo $EDITOR /etc/branchleft/broker.env   # first boot only: fill in the real values; never echo them to a shell history
   ```

   On a re-run, skip the editor line unless a value has to change. Opening the
   file to fill it in is the only thing that touches its contents here.

   Fill in a real `BROKER_VERIFY_KEY_FILE` at the path it names, 32 raw
   Ed25519 public-key bytes, owned **`root:broker`, mode 0640**. See
   `systemd/README.md` ("The verify key") for why it is group-readable
   rather than broker-owned. Leave the four `BROKER_*_MODULE` lines as the
   template ships them: every one names a module in the bundle.
   `GET /status/<slot>` lists any loaded module not marked real (a test
   stand-in, or anything unmarked) under `notReal`, and any interim module
   under `interim`. The host is not ready to go live until both lists are
   empty; with this template, both are. **Never set `LISTEN_HOST`** --
   `test/unit/listenHostDefault.test.ts` is the guard that keeps this file's
   own committed template from regressing that.

7. **Install and start the unit:**
   ```bash
   sudo install -o root -g root -m 0644 systemd/branchleft-broker.service /etc/systemd/system/branchleft-broker.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now branchleft-broker.service
   sudo systemctl status branchleft-broker.service
   curl -s http://127.0.0.1:8090/status/0   # {"slot":"0","phase":"free","healthy":false}
   ```

## Upgrade

An upgrade is a new release directory plus a symlink swap and restart --
never an in-place overwrite of `current/`, so a broker mid-request never
sees half-written files:

```bash
cd services/broker && pnpm install --frozen-lockfile && pnpm run bundle
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"
rsync -a --chown=root:root -e 'ssh -i ~/.ssh/id_ed25519_hetzner' dist/bundle/ "${DEMO1_SSH_USER}@${DEMO1_IPV4}:/tmp/broker-release-${RELEASE}/"
ssh -i ~/.ssh/id_ed25519_hetzner "${DEMO1_SSH_USER}@${DEMO1_IPV4}" "sudo mv /tmp/broker-release-${RELEASE} /opt/branchleft/broker/releases/${RELEASE} && sudo ln -sfn /opt/branchleft/broker/releases/${RELEASE} /opt/branchleft/broker/current && sudo systemctl restart branchleft-broker.service"
ssh -i ~/.ssh/id_ed25519_hetzner "${DEMO1_SSH_USER}@${DEMO1_IPV4}" 'curl -s http://127.0.0.1:8090/status/0'
```

`Restart=on-failure` (the unit file) does not cover this step -- a restart
here is deliberate, not a crash recovery, so it stays an explicit
`systemctl restart` rather than something the unit triggers on its own.
Keep at least the previous two releases under `releases/` for a manual
rollback (`ln -sfn` to the older directory, then restart); nothing here
automates pruning them.

## Release artifact and how to verify it

`.github/workflows/broker-release.yml` builds the bundle in CI, signs it and
publishes it as a GitHub Release. This section is the one home of that
contract: the shared-infra `broker_deploy` role consumes it, and the hand
build in the Install and Upgrade steps above stays only until that role
replaces it.

**What a release is.** A tag `broker-vX.Y.Z` whose `X.Y.Z` is the `version`
in `services/broker/package.json`, cut as a signed, annotated tag on a commit
on `main`. A tag `vX.Y.Z` or `render-core-vX.Y.Z` never starts the workflow.
There is no manual trigger.
A published release is never replaced; a fix ships as a new version.

**What the tag check is.** Before anything is signed, the release job runs
`release/check_release_tag.py`. It fails closed, and it refuses a tag that is
not:

1. named `broker-vMAJOR.MINOR.PATCH`, nothing more;
2. the same version as `services/broker/package.json`;
3. annotated (a tag object), not a lightweight pointer at a commit;
4. signed, with a signature GitHub itself reports as verified;
5. on a commit that is an ancestor of `origin/main`;
6. on the commit this run built, so a tag moved or re-pushed between the build
   job and the release job is refused.

This is a guard against mistakes, not a control. It runs from the tagged
commit's own copy of the script and the workflow, so a tag on a branch commit
that edits them passes its own check, and the attestation records
`refs/tags/<tag>`, not `main`. Nothing the verifier checks proves the tag is
annotated, on `main`, or the only tag allowed. The controls are the tarball
sha256 pinned in reviewed shared-infra code, and the consumer's check below
that the attested commit is on `main`.

**Why the bytes are the same every time.** `release/pack-release.sh` makes the
tarball deterministic: the same bundle contents give the same bytes whatever
the file times, the owner, the umask or the order the files were written in.
That is what lets a reviewed digest in another repo pin a release, and what
lets a pull request prove the packing without a tag (the workflow packs twice
and compares). Members are the bundle's contents with no leading directory, so
they unpack straight into a release directory. GNU tar is required (`--sort`,
`--mtime`, `--owner`); the script refuses any other tar rather than pack
differently. Tag runs, which sign, install without the pnpm cache; pull
requests and branches keep it.

**The three assets**, each fetchable anonymously, no token:

| Asset                                 | What it is                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `broker-bundle-X.Y.Z.tar.gz`          | `broker.mjs` and `plugins/*.mjs`, no leading directory, deterministic bytes     |
| `broker-bundle-X.Y.Z.tar.gz.sha256`   | `sha256sum` output for the tarball                                              |
| `broker-bundle-X.Y.Z.tar.gz.sigstore.json` | the GitHub artifact attestation (SLSA provenance) for the tarball          |

Unpacked, the tree is what `broker_deploy_bundle_src` already expects.

**Verify, from an empty directory.** Set `VERSION` to the version being
deployed and `PINNED_SHA256` to the digest recorded for it in reviewed code
(the role's pin, not the `.sha256` file from the release):

```bash
set -euo pipefail
TAG="broker-v${VERSION}"
BASE="https://github.com/branchLeft/ghost-platform/releases/download/${TAG}"
curl -fsSLO "${BASE}/broker-bundle-${VERSION}.tar.gz"
curl -fsSLO "${BASE}/broker-bundle-${VERSION}.tar.gz.sigstore.json"
gh attestation trusted-root > trusted_root.jsonl
gh attestation verify "broker-bundle-${VERSION}.tar.gz" \
  --bundle "broker-bundle-${VERSION}.tar.gz.sigstore.json" \
  --repo branchLeft/ghost-platform \
  --signer-workflow branchLeft/ghost-platform/.github/workflows/broker-release.yml \
  --source-ref "refs/tags/${TAG}" \
  --deny-self-hosted-runners \
  --custom-trusted-root trusted_root.jsonl \
  --format json > verified.json
echo "${PINNED_SHA256}  broker-bundle-${VERSION}.tar.gz" | sha256sum --check --strict
```

Both must pass. Change one byte of the tarball and the `gh attestation verify`
line fails: that is the negative control.

**Check the attested commit is on main.** The verify above proves where the
bytes came from, not that the commit is on `main`. Read the source commit the
attestation names from `verified.json` (the certificate's source digest), refuse
anything that is not a 40-character sha before it goes into a URL (the whole
value must match, so a value with a second line is refused), and ask the
GitHub compare API, anonymously, how that commit relates to `main`. The branch
is named in full, `refs/heads/main`, because a bare `main` can resolve to a tag
of that name and the `release tags` ruleset does not stop one being pushed. The
pass condition is `behind` or `identical`. Any other answer (`ahead`,
`diverged`), an empty answer, a failed request or a malformed commit fails the
deploy: it exits 1 and nothing is unpacked or installed.

```bash
set -euo pipefail
SOURCE_COMMIT="$(jq -r '.[0].verificationResult.signature.certificate.sourceRepositoryDigest' verified.json)"
if ! [[ "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "refusing: the attested source commit '${SOURCE_COMMIT}' is not a 40-hex sha" >&2
  exit 1
fi
STATUS="$(curl -fsS "https://api.github.com/repos/branchLeft/ghost-platform/compare/refs/heads/main...${SOURCE_COMMIT}" | jq -r .status)"
case "${STATUS}" in
  behind | identical) ;;
  *)
    echo "refusing: ${SOURCE_COMMIT} is not on main (compare status '${STATUS}')" >&2
    exit 1
    ;;
esac
```

The compare API is unauthenticated, which allows 60 requests per hour per
address: ample for a deploy.

**Not yet exercised.** Four things here have not been observed and the first
consumer run proves three of them: `gh attestation verify --bundle ... --custom-trusted-root`
working without a logged-in `gh`; `gh attestation trusted-root` working
without a logged-in `gh`; and the JSON field that carries the source digest
(`.[0].verificationResult.signature.certificate.sourceRepositoryDigest` above).
The fourth is that `GITHUB_SHA` on an annotated-tag push is the commit and not
the tag object, which the release workflow passes to the tag check as the commit
being built. If it is the tag object the check fails closed: it refuses every
release and signs nothing, so nothing unsafe ships. The first live tag shows
which it is. If any one behaves differently, this section changes to match what
was observed.

**What this does and does not prove.** The attestation shows the commit the
tag named when the run started, and which workflow run produced the bytes
(`broker-release.yml` at `refs/tags/broker-vX.Y.Z`). It does not show the bytes
are a clean build of that commit, who pushed the tag, or that the tag check
was the one on `main`. The controls are the pinned digest, which makes
reviewed code choose which release deploys, and the check above that the
attested commit is on `main`. This is the same trust in GitHub that
branchLeft/workspace#2483 accepted for merge signatures; moving to a key of
our own later changes only the attest step and the flags above. The `release
tags` repository ruleset covers `v[0-9]*.[0-9]*.[0-9]*` only, so until it also
names `broker-v*` a `broker-v*` tag has no deletion or update protection; the
digest pin is what keeps a moved tag from deploying.

**Install from the release.** Unpack into a new release directory and swap
`current` as in Upgrade above; never unpack over `current/`:

```bash
mkdir "broker-release-${VERSION}"
tar -xzf "broker-bundle-${VERSION}.tar.gz" -C "broker-release-${VERSION}"
```

**Roll back** by pinning the previous version and its digest in the role and
running it again. Older releases stay published, so the previous tarball and
its attestation are still there to verify.

## Proof

`.github/workflows/broker-systemd-boot-ci.yml` boots a real `systemd`
inside a throwaway container (the same "throwaway container, not the
runner's own sudo configuration" reasoning `demo-host-sudoers-ci.yml`
already gives, extended to a real PID 1: this installs a sudoers rule and a
system user, neither of which belongs on whatever runs the build), installs
the bundle, the unit and the sudoers boundary exactly as this runbook's
install steps do, starts the unit under `systemctl`, and:

1. confirms the unit is `active (running)` under real `systemd`, not merely
   that the Node process launched;
2. calls the real `GET /status/0` and checks the JSON body;
3. sends a real signed `POST /reset` (the same Ed25519 scheme
   `test/helpers/signer.ts` uses) and confirms it reaches
   `branchleft_slot.py` through a real `sudo -n` -- the journal is checked
   for an actual `sudo` session opened for root running the wrapper, not
   merely a 200 response. The fixture installs one trivial, real (not
   faked) `branchleft-compose@.service` template as a stand-in for the
   per-colour unit `branchleft_slot.py` starts and stops -- content and
   delivery owned by branchLeft/workspace#1448, out of this issue's scope
   -- so the wrapper's own real `systemctl stop` calls have something to
   succeed against.

Everything this proof found by actually booting the unit -- not by reading
the issue or the systemd docs -- is explained in full in `systemd/README.md`,
with a short pointer at each line the finding fixed.

Run locally the same way CI does, from the repo root (the build needs both
`demo-host/provision/` and `services/broker/dist/bundle/` -- run `pnpm run
bundle` in `services/broker` first):

```bash
docker build -f services/broker/test/live/fixtures/systemd-boot/Dockerfile -t branchleft-broker-boot-proof .
docker run -d --name broker-boot-proof --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw branchleft-broker-boot-proof
docker exec broker-boot-proof systemctl is-active branchleft-broker.service
docker exec broker-boot-proof curl -s http://127.0.0.1:8090/status/0
docker exec broker-boot-proof cat /var/lib/branchleft/broker-slots/slots.json   # carries the fixture's seeded leased slot "0"
docker exec broker-boot-proof /opt/branchleft/broker/node/bin/node /opt/branchleft/broker/proof/sign-request.mjs POST /reset '{"slot":"0"}' /opt/branchleft/broker/proof/signing-key.bin http://127.0.0.1:8090
docker exec broker-boot-proof cat /var/lib/branchleft/broker-slots/slots.json   # the leased entry is gone: the write-rename reached the real mount
docker rm -f broker-boot-proof
```

## Left out, deliberately

- **`GET /drain` never hands anything over.** That is final, not a gap:
  the shipped drain source answers `502` and logs that mail is collected
  from the mail queue directly.
- **`BROKER_SLOTS_FILE` writability.** This issue's own scope: the file and
  its containing directory (`/var/lib/branchleft/broker-slots`, broker-owned
  inside a root-owned parent) are created by step 5 above and are in the
  unit's `ReadWritePaths=`, so a real `/reconcile` or
  `/reset` can write it. The shape is `{"slots": []}`
  (`slotsFile.ts#readSlotsFile` reads `parsed.slots` as the array itself,
  not `{}`) -- the boot proof's fixture seeds a real leased entry and
  resets it, so this can't silently regress again. See `systemd/README.md`.
- **`BROKER_SLOT_DIR_BASE` and the wrapper's slot directory.** Fixed: the
  broker writes under `<BROKER_SLOT_DIR_BASE>/demo-<slot>/`, the directory
  the wrapper's `reset` wipes, so a reset clears what a reconcile wrote.
  `reset` also empties the contents of the slot's Ghost data volume and
  content volume (never the adapters volume, and never removing a volume),
  so the next lease starts from a fresh Ghost. It finds the content volume by
  reading the name from the slot's `compose.yml` before emptying the
  directory; `demo-host/provision/branchleft_slot.md` has the detail.
  Both sides are pinned by tests to `demo-host/provision/slot-dirs.golden.json`,
  derived from the sudoers generator's slot table.
