# resolve-published-image.sh

## What this does

Prints `<image>@sha256:<digest>` for the image a publish workflow most recently
pushed from `main`, so a check can name the current image by digest.

```sh
GH_TOKEN=<token that reads runs> ./scripts/resolve-published-image.sh \
    <workflow-file> <ghcr.io/owner/name>
```

It lists the newest successful push runs of the workflow on `main`, in order,
and takes each run's head sha. For each one it reads the digest the registry
holds for the tag of that sha, and prints the first that resolves. It exits
non-zero when none does.

## Why it works this way

- The tag is the commit sha the push job writes. Neither `latest` nor the main
  head sha is safe: a cancelled or in-flight run can leave a tag with no
  attestation yet, so the newest successful run is the source.
- The loop is needed for an image whose push job does not run on every commit.
- Only the run listing needs a token. The digest is read anonymously from the
  registry, so the token is set in the calling step only.
- The digest must match `sha256:<64 hex>`, or the script refuses it.
