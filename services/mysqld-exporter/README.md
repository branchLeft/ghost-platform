# mysqld-exporter image

`prometheus/mysqld_exporter`, rebuilt from its release source so the modules it
links can be patched ahead of an upstream release. It runs on the database host
(`db/stack/compose.yml`, service `mysqld-exporter`) and takes the same command
line as the upstream image: same entrypoint, same port, same unprivileged user.

## What is pinned

Everything the build trusts is a literal in `Dockerfile`, and `workflow-mysqld-exporter-image.test.js` fails if any of it loosens.

| Input | How it is pinned |
| --- | --- |
| Go toolchain | `golang` image, tag and digest. `GOTOOLCHAIN=local`, so no other toolchain is fetched. |
| Exporter source | Release tag `v0.21.0`, fetched as a Go module. The build stops unless the module hash (`EXPORTER_MODULE_SUM`) and the commit it was cut from (`EXPORTER_COMMIT`) match. The Go checksum database is on. |
| Patched modules | `golang.org/x/net` and `github.com/klauspost/compress` raised with `go get`, then `go mod tidy` and `go mod verify`. The build stops unless `go list -m` and the binary's own build info report the pinned versions. |
| Final image | `alpine` image, tag and digest. The package manager is removed, so the image holds the binary, the licences, busybox and musl. |

Nothing sets `GOFLAGS`, `GOSUMDB`, `GONOSUMDB` or `GOINSECURE`: module downloads are checked against `go.sum` and the checksum database.

## Licences

The exporter is Apache-2.0. Its `LICENSE` and `NOTICE` are copied into
`/licenses/mysqld_exporter/`, and the licence, notice and copying files at the
root of every other module the binary is built from are copied into
`/licenses/<module path>/`.

## Why the final image is Alpine

The compose healthcheck pipes `wget` into `grep` under `sh`. The upstream image
gets them from busybox, and so does this one. The version is whatever the pinned
Alpine ships, and the scan names it.

## Raising a pin

1. Read the new tag's commit and module hash from the Go module proxy
   (`go mod download -json github.com/prometheus/mysqld_exporter@vX.Y.Z` prints `Sum` and `Origin.Hash`), and update `EXPORTER_VERSION`, `EXPORTER_COMMIT` and `EXPORTER_MODULE_SUM` together.
2. Read the new image digests from the registry for the Go and Alpine tags, and update tag and digest together.
3. Run `govulncheck ./...` against the new source with the module pins applied. Drop a module pin once the upstream `go.mod` already requires a patched release.
4. Run `node --test workflow-mysqld-exporter-image.test.js`.

The workflow publishes `ghcr.io/branchleft/mysqld-exporter@sha256:...` on a merge to `main`, behind the shared image scan. The stack pins that digest once the scan and the attestation have both passed.
