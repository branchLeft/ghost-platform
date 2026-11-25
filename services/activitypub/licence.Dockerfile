# Adds the upstream licence to an upstream image, built from the pinned source
# by the image workflow. The upstream Dockerfiles do not copy their licence into
# the image, so this overlay does, and keeps the upstream entrypoint, command,
# port and user unchanged.
ARG UPSTREAM_IMAGE
FROM ${UPSTREAM_IMAGE}

COPY LICENSE /licenses/LICENSE
