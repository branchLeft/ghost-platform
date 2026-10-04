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

## Runtime: a bundled single file, not a plain `npm ci` on the host

`services/broker/package.json` depends on
`@branchleft/ghost-platform-render-core` via `file:../../render-core`.
Installed locally (`npm ci` in this checkout), that resolves to a symlink
four directories up (`node_modules/@branchleft/ghost-platform-render-core
-> ../../../../render-core`) -- proven by running it, not assumed. render-
core's own `package.json` says why a normal host install can't lean on the
registry instead: "to be published the same way ... no publish workflow
exists for it yet" (`CLAUDE.md`). A host install would therefore need the
whole monorepo checkout staged at that exact relative layout, which is
fragile to rsync and easy to let drift from what actually shipped.

Instead, `npm run bundle` (`esbuild.bundle.mjs`) produces five self-
contained ESM files with render-core (and this package's own modules)
inlined:

- `dist/bundle/broker.mjs` -- the one entrypoint Node runs.
- `dist/bundle/plugins/renderCorePlugin.mjs` -- the real `Renderer` seam.
- `dist/bundle/plugins/dockerImageLoader.mjs` -- the real `ImageLoader`
  seam.
- `dist/bundle/plugins/refusingDrainSource.mjs` -- the final `DrainSource`
  seam: it refuses every poll, because mail is collected from the mail
  queue directly and nothing is handed over through the broker.
- `dist/bundle/plugins/refusingAdminApi.mjs` -- an interim `AdminApiClient`
  that refuses every build until the real client ships (see "Left out,
  deliberately").

Each file has no `node_modules` dependency once built: `server.ts#loadPlugin`
reaches the plugin modules through a runtime `import()` of an environment
variable's value, which esbuild cannot inline through, so they are bundled
as separate entrypoints rather than folded into `broker.mjs` itself.

Node itself is a pinned source, not bundled: this package's own `.nvmrc`
(`v26.5.0`) is the version to install, matching what CI and every
contributor's checkout already use.

## Install (first boot)

Run from a workstation checkout with SSH access to demo1 -- an operator
step; nothing here runs from CI (`services/broker/**`'s
`.claude/delivery-paths.json` row is `not_merge_delivered`/`version_pin`,
because no publish path exists yet either -- see "Delivery path" below).

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
   npm ci
   npm run bundle
   ssh demo1 'sudo mkdir -p /opt/branchleft/broker/releases'
   RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"
   rsync -a --chown=root:root dist/bundle/ "demo1:/tmp/broker-release-${RELEASE}/"
   ssh demo1 "sudo mv /tmp/broker-release-${RELEASE} /opt/branchleft/broker/releases/${RELEASE} && sudo ln -sfn /opt/branchleft/broker/releases/${RELEASE} /opt/branchleft/broker/current"
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
   sudo mkdir -p /var/lib/branchleft && sudo chown broker:broker /var/lib/branchleft
   ```

6. **Write `/etc/branchleft/broker.env`** on demo1 from
   `systemd/broker.env.example`, root:root, mode 0600:
   ```bash
   sudo install -o root -g root -m 0600 /dev/null /etc/branchleft/broker.env
   sudo $EDITOR /etc/branchleft/broker.env   # fill in the real values; never echo them to a shell history
   ```
   Fill in a real `BROKER_VERIFY_KEY_FILE` at the path it names, 32 raw
   Ed25519 public-key bytes, owned **`root:broker`, mode 0640**. See
   `systemd/README.md` ("The verify key") for why it is group-readable
   rather than broker-owned. Leave the four `BROKER_*_MODULE` lines as the
   template ships them: every one names a module in the bundle. If one is
   ever pointed at a test stand-in under `test/live/fixtures/`,
   `GET /status/<slot>` lists it under `standIns`, and the host is not
   ready to go live until that list is empty. **Never set `LISTEN_HOST`** --
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
cd services/broker && npm ci && npm run bundle
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"
rsync -a --chown=root:root dist/bundle/ "demo1:/tmp/broker-release-${RELEASE}/"
ssh demo1 "sudo mv /tmp/broker-release-${RELEASE} /opt/branchleft/broker/releases/${RELEASE} && sudo ln -sfn /opt/branchleft/broker/releases/${RELEASE} /opt/branchleft/broker/current && sudo systemctl restart branchleft-broker.service"
ssh demo1 'curl -s http://127.0.0.1:8090/status/0'
```

`Restart=on-failure` (the unit file) does not cover this step -- a restart
here is deliberate, not a crash recovery, so it stays an explicit
`systemctl restart` rather than something the unit triggers on its own.
Keep at least the previous two releases under `releases/` for a manual
rollback (`ln -sfn` to the older directory, then restart); nothing here
automates pruning them.

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
`demo-host/provision/` and `services/broker/dist/bundle/` -- run `npm run
bundle` in `services/broker` first):

```bash
docker build -f services/broker/test/live/fixtures/systemd-boot/Dockerfile -t branchleft-broker-boot-proof .
docker run -d --name broker-boot-proof --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw branchleft-broker-boot-proof
docker exec broker-boot-proof systemctl is-active branchleft-broker.service
docker exec broker-boot-proof curl -s http://127.0.0.1:8090/status/0
docker exec broker-boot-proof cat /var/lib/branchleft/slots.json   # carries the fixture's seeded leased slot "0"
docker exec broker-boot-proof /opt/branchleft/broker/node/bin/node /opt/branchleft/broker/proof/sign-request.mjs POST /reset '{"slot":"0"}' /opt/branchleft/broker/proof/signing-key.bin http://127.0.0.1:8090
docker exec broker-boot-proof cat /var/lib/branchleft/slots.json   # the leased entry is gone: the write-rename reached the real mount
docker rm -f broker-boot-proof
```

## Left out, deliberately

- **A real `BROKER_ADMIN_API_MODULE`.** The shipped one refuses every
  build, so `POST /reconcile` answers `503` (a fresh build ends with the
  slot in `error`; a colour swap leaves the slot on its current colour) and
  the journal names why. `/status`, `/reset` and `/stop` never call it and
  work normally. Swapping in the real client is a one-line change to this
  env file once it ships.
- **`GET /drain` never hands anything over.** That is final, not a gap:
  the shipped drain source answers `502` and logs that mail is collected
  from the mail queue directly.
- **`BROKER_SLOTS_FILE` writability.** This issue's own scope: the file and
  its containing directory (`/var/lib/branchleft`) are created by step 5
  above and are in the unit's `ReadWritePaths=`, so a real `/reconcile` or
  `/reset` can write it. The shape is `{"slots": []}`
  (`slotsFile.ts#readSlotsFile` reads `parsed.slots` as the array itself,
  not `{}`) -- the boot proof's fixture seeds a real leased entry and
  resets it, so this can't silently regress again. See `systemd/README.md`.
- **`BROKER_SLOT_DIR_BASE` vs. the wrapper's own path.** Still open:
  `writeArtefacts.ts` writes under `<BROKER_SLOT_DIR_BASE>/<slot>/`, but
  `branchleft_slot.py`'s `reset` wipes `/opt/branchleft/demo-<slot>` -- a
  different, hyphenated path no value of `BROKER_SLOT_DIR_BASE` can produce
  through `path.join`. A reset therefore never clears what a prior
  reconcile wrote. Fixing it touches either `writeArtefacts.ts`'s own
  directory convention (tested elsewhere against `<base>/<slot>`) or the
  wrapper's `SLOT_DIR` -- both branchLeft/workspace#1447/#1448's territory,
  not this issue's, and not worked around here. See `systemd/README.md`
  ("Known gap").
