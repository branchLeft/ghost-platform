# A thin layer over the Percona Server 8.0.46-37 image: the same server, the
# same entrypoint, the same data directory and the same user, with the operating
# system packages brought to their fixed versions and the two parts the
# database host does not use taken out. Why each change is made, and what is
# deliberately not changed, is in README.md beside this file.

# The registry comes from one build argument whose default is the public
# source, so a local build pulls this exact digest with no credential. CI alone
# passes IMAGE_REGISTRY=ghcr.io/branchleft/mirror-private2; the digest, and so
# the bytes, are the same either way. The digest is the multi-platform index of
# 8.0 at 8.0.46-37, the one .github/image-mirror/images.json lists.
ARG IMAGE_REGISTRY
FROM ${IMAGE_REGISTRY:-docker.io/percona}/percona-server:8.0@sha256:a4ba7d1afd325f40bc6d65b6455fb4f15388638dfa39e3b85f9755755fd9ec2d

LABEL org.opencontainers.image.source="https://github.com/branchLeft/ghost-platform" \
      org.opencontainers.image.description="Percona Server 8.0.46-37 with fixed operating system packages, without the telemetry agent or MySQL Shell"

USER root

# With this set the base entrypoint takes its disabled branch: it starts the
# server with percona_telemetry_disable=1 and never starts the telemetry
# supervisor, which would otherwise call out before the server starts.
ENV PERCONA_TELEMETRY_DISABLE=1

# One layer, so nothing removed here stays in a lower layer.
#
# rpm -e --nodeps: the server package declares the telemetry agent as a
# dependency, and a package-manager removal would take the server with it. The
# server needs neither the agent nor the shell, and the check at the end of
# this step proves the server is still installed at the pinned version.
#
# The update reads the two UBI repositories only. The Percona repositories the
# base image configures stay disabled, so the server packages cannot move and
# only operating system packages are raised to the versions UBI publishes.
RUN set -eux; \
    rpm -e --nodeps percona-telemetry-agent percona-mysql-shell; \
    rm -f /call-home.sh /usr/bin/telemetry-agent-supervisor.sh; \
    microdnf --disablerepo='*' --enablerepo=ubi-9-baseos-rpms --enablerepo=ubi-9-appstream-rpms update -y; \
    microdnf clean all; \
    rm -rf /var/cache/dnf /var/cache/yum; \
    rpm -q percona-server-server | grep -Fx "percona-server-server-8.0.46-37.1.el9.$(uname -m)"; \
    for removed in percona-telemetry-agent percona-mysql-shell; do \
        if rpm -q "$removed"; then echo "$removed is still installed" >&2; exit 1; fi; \
    done; \
    mysqld --version | grep -F 'Ver 8.0.46-37'

USER mysql
