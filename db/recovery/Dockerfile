# branchLeft db1 recovery image.
#
# Recovery does not run on the tenant database host -- in the scenario this
# image exists for, that host is gone. This image is the pinned, pre-tested
# alternative to assembling `mysql`, `mysqldump` and `mysqlbinlog` by hand on
# whatever machine the drill or an incident stands up: pull one image rather
# than repeat db1's own bootstrap under worse conditions. See
# db/recovery/README.md and design 09-backup-and-recovery.html §05 (R5).
#
# Base pinned to an explicit tag *and* digest (not `latest`, not a bare major
# tag) so a rebuild is reproducible and a base-image swap is always a
# visible, reviewed diff -- same convention as the tenant Ghost image
# (../../Dockerfile). Verified locally: `docker pull debian:trixie-slim`
# resolved to this digest on 2026-09-23. trixie, not bookworm: db1 itself
# runs Debian 13 (shared-infra/hetzner/estate/Pulumi.production.yaml), and
# install_host_prereqs.py below is written and tested against trixie
# specifically -- it pulls the MySQL client packages from the apt.mysql.com
# **bookworm** component (trixie has none) while everything else about the
# base OS, including the libaio1 gap it works around, is trixie's.
#
# Build with `--platform linux/amd64` explicitly. db1 and every other
# estate host (`infra/hosts/Pulumi.production.yaml`'s `cx23` server type)
# are amd64; a recovery host is provisioned the same way. Without the flag,
# an arm64 build machine (this was built and proven on one) silently
# produces an arm64 image whose `libaio1` `.deb` -- itself pinned by
# filename in install_host_prereqs.py -- is amd64-only and fails the build,
# which is the good outcome; a base image that happened to ship an arm64
# `libaio1` would instead produce a recovery image that boots and passes
# every version check on the build machine while being unusable on the
# amd64 host it exists to recover.
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

# python3, gnupg and ca-certificates are what install_host_prereqs.py needs
# to run at all (it shells out to gpg, apt-get and dpkg, and fetches over
# https via the standard library) -- nothing here is part of the toolchain
# the image exists to carry.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The exact script db1 itself runs (db/RUNBOOK-db.md §1) to converge onto
# `age` and a MySQL-8.0-matched client toolchain -- copied rather than
# re-derived, so this image and the host it recovers for can never pin the
# toolchain two different ways. Its own `verify()` step runs as part of this
# RUN, so a base-image or upstream-package change that breaks the version
# match fails the build here rather than shipping an unmatched image.
COPY db/provision/install_host_prereqs.py /opt/branchleft/install_host_prereqs.py
RUN python3 /opt/branchleft/install_host_prereqs.py \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# A toolbox image: nothing to serve, no default command that does anything
# on its own. The runbook and the drill both invoke `mysql`/`mysqldump`/
# `mysqlbinlog`/`age` inside it directly.
CMD ["bash"]
