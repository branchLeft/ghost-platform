# test-verify-image-attestation.sh

## What this proves

`scripts/verify-image-attestation.sh` is the check that says whether an image
was built by the expected workflow. This test shows it refuses what it should,
using a stub `gh` on `PATH`, so it needs no network, no registry and no
attestation, and runs on a pull request.

The stub behaves like `gh attestation verify` where it matters: it needs
`--repo`, rejects a `--signer-workflow` that is not the one the image was
signed with, rejects a `--source-ref` other than `refs/heads/main`, and
accepts anything in the repository when a flag is left off. A script that
quietly dropped `--signer-workflow` would therefore be accepted by the stub.

## Cases

- a: the correct digest reference and identity verify, and every identity flag
  is forwarded to `gh` (`--repo`, `--signer-workflow`, `--source-ref`,
  `--cert-oidc-issuer`, `--deny-self-hosted-runners`). `--bundle-from-oci` is
  sent only when asked for.
- b: a tag-form, bare, short-digest or upper-case reference is refused and `gh`
  is never called.
- c: a signer workflow other than the one the image was signed with is
  rejected, and a signer in another repository or not a workflow path is
  refused before `gh`.
- d: a missing or surplus argument is refused before `gh`.
- e: `gh` failing is a non-zero exit.

## Showing it red

Delete the `--signer-workflow` argument from the script and case a and the
wrong-signer cases fail. Delete the digest-form refusal and the tag-form cases
fail. Restore the script and everything passes. A change to the script that
weakens either is caught here, in CI, by `image-attestation-ci.yml`.

## Not proven here

This test cannot show that a real attestation is created or accepted. That is
shown by the publish workflows themselves, which verify after attesting and
then check that a wrong identity is rejected, on every push to `main`.
