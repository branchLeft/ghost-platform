# syntax=docker/dockerfile:1
# The directive above has to be the first line -- a comment before it makes
# it an ordinary comment. It pins the stable frontend rather than whichever
# one the local daemon happens to bundle.
#
# prometheus/mysqld_exporter rebuilt from its release source with
# golang.org/x/net raised to a patched release. The upstream image ships the
# version its go.mod names, and that version has published fixes. README.md
# beside this file says what is pinned and how to bump it.

# Builder. Pinned by digest as well as tag: the digest is the multi-arch index
# of golang:1.27.3-alpine3.24 as read from Docker Hub, so a re-pointed tag
# cannot change the compiler. The exporter's go.mod asks for Go 1.26.0 or
# newer. Build tools are not shipped; only /out is copied into the final image.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS build

# What is built, as ENV rather than ARG so a --build-arg cannot change it.
# EXPORTER_COMMIT is the commit the upstream release tag points at.
# EXPORTER_MODULE_SUM is the module's go.sum hash, which the Go checksum
# database also vouches for. XNET_VERSION is the patched golang.org/x/net and
# COMPRESS_VERSION the patched github.com/klauspost/compress, which the
# exporter's go.sum carries for its tests but its binary does not link.
ENV EXPORTER_VERSION=0.21.0 \
    EXPORTER_COMMIT=8feed91b970d346a15c12f164957c8f9a0e3291e \
    EXPORTER_MODULE_SUM=h1:ZCpQHJqLiwqYxKn2JmbMDsoGNEAB0YKevy6jcU+tuII= \
    XNET_VERSION=v0.62.0 \
    COMPRESS_VERSION=v1.20.2

# The toolchain stays the one in the image, and module downloads keep their
# default proxy and checksum database: nothing here turns verification off.
ENV GOTOOLCHAIN=local \
    CGO_ENABLED=0

ARG TARGETOS
ARG TARGETARCH

# Fetch the release through the module proxy. The download is refused unless
# the checksum database agrees with it, and this step then refuses it again
# unless both the module hash and the commit it was built from are the ones
# pinned above. An empty value fails the comparison, so a changed output
# format fails the build rather than skipping the check.
WORKDIR /src
RUN set -eu; \
    go mod download -json "github.com/prometheus/mysqld_exporter@v${EXPORTER_VERSION}" > /tmp/module.json; \
    dir="$(sed -n 's/^[[:space:]]*"Dir": "\(.*\)",$/\1/p' /tmp/module.json)"; \
    sum="$(sed -n 's/^[[:space:]]*"Sum": "\(.*\)",$/\1/p' /tmp/module.json)"; \
    commit="$(sed -n 's/^[[:space:]]*"Hash": "\(.*\)",$/\1/p' /tmp/module.json)"; \
    test -n "$dir"; \
    test "$sum" = "$EXPORTER_MODULE_SUM"; \
    test "$commit" = "$EXPORTER_COMMIT"; \
    cp -R "$dir/." /src; \
    chmod -R u+w /src

# Raise the two modules, then let the module tooling settle the rest of the
# graph and check every downloaded module against go.sum. The last line
# refuses the step unless both pins took.
RUN set -eu; \
    go get "golang.org/x/net@${XNET_VERSION}" "github.com/klauspost/compress@${COMPRESS_VERSION}"; \
    go mod tidy; \
    go mod verify; \
    test "$(go list -m -f '{{.Version}}' golang.org/x/net)" = "$XNET_VERSION"; \
    test "$(go list -m -f '{{.Version}}' github.com/klauspost/compress)" = "$COMPRESS_VERSION"

# -trimpath keeps build paths out of the binary. The ldflags are the ones the
# upstream release build sets, less the build date and host, which would make
# two builds of the same source differ.
RUN set -eu; \
    pkg=github.com/prometheus/common/version; \
    GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath \
      -ldflags "-X ${pkg}.Version=${EXPORTER_VERSION} -X ${pkg}.Revision=${EXPORTER_COMMIT} -X ${pkg}.Branch=HEAD -X ${pkg}.BuildUser=branchleft" \
      -o /out/mysqld_exporter . ; \
    go version -m /out/mysqld_exporter | grep -Eq "^[[:space:]]+dep[[:space:]]+golang\.org/x/net[[:space:]]+${XNET_VERSION}[[:space:]]"

# Apache-2.0 asks that the licence and NOTICE travel with a redistributed
# binary. The exporter's own are copied, and so is every licence, notice and
# copying file at the root of each module the binary is built from.
RUN set -eu; \
    mkdir -p /out/licenses/mysqld_exporter; \
    cp LICENSE NOTICE /out/licenses/mysqld_exporter/; \
    GOOS="$TARGETOS" GOARCH="$TARGETARCH" go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}} {{.Dir}}{{end}}{{end}}' . | sort -u | \
    while read -r path dir; do \
      for file in "$dir"/LICEN[CS]E* "$dir"/NOTICE* "$dir"/COPYING*; do \
        [ -f "$file" ] || continue; \
        mkdir -p "/out/licenses/$path"; \
        cp "$file" "/out/licenses/$path/"; \
      done; \
    done; \
    test "$(find /out/licenses -type f | wc -l)" -gt 2

# Final image. Alpine rather than upstream's busybox base because the db1
# stack's healthcheck needs wget, grep and sh, and Alpine's busybox carries
# them. Pinned by digest as well as tag, as the other Alpine images here are.
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

LABEL org.opencontainers.image.title="mysqld_exporter" \
      org.opencontainers.image.description="Prometheus exporter for MySQL server metrics, rebuilt from the upstream release with a patched golang.org/x/net" \
      org.opencontainers.image.url="https://github.com/prometheus/mysqld_exporter" \
      org.opencontainers.image.version="0.21.0" \
      org.opencontainers.image.revision="8feed91b970d346a15c12f164957c8f9a0e3291e" \
      org.opencontainers.image.licenses="Apache-2.0"

# The exporter never installs a package. Removing the package manager removes
# it and the libraries only it needs (zlib among them) from the image, so
# nothing in it can be upgraded in place and nothing unused is left to scan.
RUN apk del --no-cache apk-tools

COPY --from=build /out/mysqld_exporter /bin/mysqld_exporter
COPY --from=build /out/licenses /licenses

# The same port, user and entrypoint as the upstream image, so the compose
# command that configures it does not change.
EXPOSE 9104
USER nobody
ENTRYPOINT [ "/bin/mysqld_exporter" ]
