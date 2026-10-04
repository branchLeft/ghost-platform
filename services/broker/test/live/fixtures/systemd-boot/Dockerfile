# A real systemd as PID 1, so RUNBOOK-broker-deploy.md's install steps and
# the unit's own hardening directives (`../../../../systemd/branchleft-broker.service`)
# can be proven against real `systemctl`, not a stand-in -- the boot proof
# `broker-systemd-boot-ci.yml` runs. Throwaway container, not the runner's
# own init, for the same reason `demo-host-sudoers-ci.yml` gives for its own
# throwaway container: this installs a sudoers rule and a system user,
# neither of which belongs on whatever runs this build.
#
# Built with the repo ROOT as context (`docker build -f
# services/broker/test/live/fixtures/systemd-boot/Dockerfile .`, from the
# repo root) so this Dockerfile can COPY the real `demo-host/provision/`
# wrapper -- the exact files RUNBOOK-broker-deploy.md's install steps 1-3
# use, never a copy -- alongside `services/broker`'s own built bundle.
FROM debian:bookworm-slim

RUN apt-get update -qq \
 && apt-get install -y -qq systemd sudo python3 curl ca-certificates xz-utils libatomic1 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# The standard "run systemd as PID 1 in a container" trim: nothing here
# needs a getty, udev (no real hardware), or the other targets a bare-metal
# boot wants. Documented pattern (e.g. Red Hat's "Running systemd within a
# Docker Container"), not specific to this repo.
RUN (cd /lib/systemd/system/sysinit.target.wants/; for unit in *; do \
      [ "$unit" = systemd-tmpfiles-setup.service ] || rm -f "$unit"; \
    done) \
 && rm -f /lib/systemd/system/multi-user.target.wants/* \
 && rm -f /etc/systemd/system/*.wants/* \
 && rm -f /lib/systemd/system/local-fs.target.wants/* \
 && rm -f /lib/systemd/system/sockets.target.wants/*udev* \
 && rm -f /lib/systemd/system/sockets.target.wants/*initctl* \
 && rm -f /lib/systemd/system/basic.target.wants/* \
 && rm -f /lib/systemd/system/anaconda.target.wants/* 2>/dev/null || true

# Node, pinned exactly as RUNBOOK-broker-deploy.md's install step 1 does
# (arch mapping and checksum verification: see systemd/README.md).
ARG NODE_VERSION=v26.5.0
RUN case "$(dpkg --print-architecture)" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported dpkg architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
 && curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
 && grep " node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz\$" SHASUMS256.txt | sha256sum -c - \
 && mkdir -p /opt/branchleft/broker/node \
 && tar -xJf "node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" --strip-components=1 -C /opt/branchleft/broker/node \
 && rm "node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" SHASUMS256.txt \
 && /opt/branchleft/broker/node/bin/node --version

# The real wrapper and sudoers generator (RUNBOOK-broker-deploy.md step 3),
# straight from the repo-root build context -- never a copy pasted into
# this fixture.
COPY demo-host/provision/render_slot_sudoers.py demo-host/provision/branchleft_slot.py /repo-demo-host-provision/

RUN useradd --system --home-dir /var/lib/branchleft-broker --shell /usr/sbin/nologin broker \
 && python3 /repo-demo-host-provision/render_slot_sudoers.py --install /etc/sudoers.d/branchleft-slot \
 && install -o root -g root -m 0755 /repo-demo-host-provision/branchleft_slot.py /usr/local/sbin/branchleft-slot \
 && visudo -c

# A trivial, real (not faked) systemd template unit standing in for the
# per-colour Ghost compose unit `branchleft_slot.py` starts/stops --
# content and delivery owned by the per-colour unit/uid-claim work, out of
# this issue's scope. Without it, `systemctl stop
# branchleft-compose@demo-0-a.service` exits 5 ("not loaded") and the
# wrapper reports failure -- not a defect in this deployment form, just the
# next story's own unit not existing yet. `RemainAfterExit=yes` so `start`
# leaves it genuinely `active`, provable the same way a real compose unit
# would be.
# No `systemctl daemon-reload` here: no systemd instance is running during
# `docker build` at all (PID 1 in a build step is the shell) -- the real
# PID 1 systemd reads every unit fresh from /etc/systemd/system/ when the
# container actually boots (`ENTRYPOINT`, below).
RUN printf '[Unit]\nDescription=stand-in for the per-colour compose unit\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/true\nExecStop=/bin/true\n' > /etc/systemd/system/branchleft-compose@.service

# The bundle: built on the host by `npm run bundle` (RUNBOOK-broker-deploy.md
# step 4) and copied in exactly as the runbook's rsync step would ship it --
# this Dockerfile never runs `npm ci`/`npm run bundle` itself, so it never
# needs the GitHub Packages token render-core's own registry requires.
RUN mkdir -p /opt/branchleft/broker/releases/proof
COPY services/broker/dist/bundle/ /opt/branchleft/broker/releases/proof/
RUN ln -s /opt/branchleft/broker/releases/proof /opt/branchleft/broker/current \
 && chown -R root:root /opt/branchleft/broker/releases/proof

# The two real plugin seams this proof can wire (Renderer, ImageLoader) are
# already in that bundle. AdminApi/DrainSource have no real implementation
# anywhere in this repo yet (RUNBOOK-broker-deploy.md's "Left out,
# deliberately") -- these two no-op stand-ins exist only so the server can
# start at all for this proof, and are never what RUNBOOK-broker-deploy.md's
# install step points a real deploy at.
COPY services/broker/test/live/fixtures/systemd-boot/noop-admin-api.mjs services/broker/test/live/fixtures/systemd-boot/noop-drain-source.mjs /opt/branchleft/broker/current/plugins/

COPY services/broker/test/live/fixtures/systemd-boot/make-verify-key.mjs services/broker/test/live/fixtures/systemd-boot/sign-request.mjs /opt/branchleft/broker/proof/
# root:broker 0640, and a non-empty slots.json seeding a real leased slot
# "0": see systemd/README.md for why (ownership found by EACCES, the
# `{"slots": []}` shape found by a 500, and the non-empty seed added after a
# review round found `/reset` on an empty slots file never exercises the
# real write-rename against the ProtectSystem=strict mount at all).
RUN mkdir -p /etc/branchleft /var/lib/branchleft/broker-slots \
 && /opt/branchleft/broker/node/bin/node /opt/branchleft/broker/proof/make-verify-key.mjs /etc/branchleft/broker-verify-key.bin /opt/branchleft/broker/proof/signing-key.bin \
 && chown root:broker /etc/branchleft/broker-verify-key.bin \
 && chmod 0640 /etc/branchleft/broker-verify-key.bin \
 && printf '{"slots": [{"host": "proof-leased.demo.trypublicpress.co.uk", "slot": "0", "gate": {"kind": "passphrase", "argon2idHash": "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA"}}]}' > /var/lib/branchleft/broker-slots/slots.json \
 && chown root:root /var/lib/branchleft \
 && chown -R broker:broker /var/lib/branchleft/broker-slots

COPY services/broker/test/live/fixtures/systemd-boot/broker.env /etc/branchleft/broker.env
RUN chown root:root /etc/branchleft/broker.env && chmod 0600 /etc/branchleft/broker.env

COPY services/broker/systemd/branchleft-broker.service /etc/systemd/system/branchleft-broker.service
RUN systemctl enable branchleft-broker.service

STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/lib/systemd/systemd"]
