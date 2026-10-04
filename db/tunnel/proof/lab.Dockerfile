# A throwaway Debian 13 host for prove-replica-tunnel.sh: systemd as PID 1,
# sshd, the ssh client and the tools the probes use. Same release as the estate.
FROM debian:trixie@sha256:34cd9e9fd437c0a095ec39cb2e73422c9f30821b0d0848ed74fd0d43bae4d958
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
        openssh-server openssh-client systemd systemd-sysv iproute2 python3 procps \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
