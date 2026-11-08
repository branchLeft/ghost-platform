# probe-tokenless-attestation.sh

## What this does

Checks that the image verifier can judge an attestation with no GitHub token in
the environment, which is how a host runs it. It calls
`scripts/verify-image-attestation.sh` and never restates its logic.

```sh
./scripts/probe-tokenless-attestation.sh <real image@sha256:64hex> <forged image@sha256:64hex>
```

The probe runs three checks, in order:

1. **Environment proof.** Under the scrubbed environment, `GH_TOKEN`,
   `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` are unset,
   the gh config directory has no hosts file, and `gh auth status` exits
   non-zero. Any credential fails with `ASSERT FAILED: probe environment is not token-less`.
2. **Real digest.** The verifier runs on the real digest with
   `--bundle-from-oci`. Success prints `TOKENLESS VERIFY OK`. A token need fails
   with `ASSERT FAILED: verification needs a GitHub token`. A network or Sigstore
   fault is retried three times, 20 seconds apart, then fails as a fault, not a
   verdict. Anything else fails as a refusal for the attestation or identity.
3. **Control.** The same call on the forged digest, a real attestation from a
   different workflow, must exit non-zero with gh's identity or policy wording.
   An acceptance fails with `ASSERT FAILED: forged digest accepted: the probe is vacuous`.

The scrubbed environment copies the host's keys by hand: `PATH`, `HOME`,
`GH_CONFIG_DIR` and `XDG_CONFIG_HOME` (all an empty directory),
`GH_PROMPT_DISABLED`, `GH_NO_UPDATE_NOTIFIER`, `LC_ALL=C` and
`VERIFY_PLAIN_ERRORS=1`. The host's function lives in another repository, so
these values are restated once, here. Keep them in step with it.

## Placeholder mode

`PROBE_GH_TOKEN_PLACEHOLDER=placeholder-not-a-credential` runs the same checks
with `GH_TOKEN` set to that one literal string and `GH_DEBUG=api` on. It asks
whether gh's local auth gate takes any value on the `--bundle-from-oci` path,
and prints the GitHub API lines gh logged. Any other value is refused before gh
runs, so a real token cannot be passed this way. The workflow runs it as a
second step after the token-less one, even when that one failed.

## Why the classes are split

A token need, a transport fault and an identity refusal all make gh exit
non-zero. Only the identity refusal is a verdict. A probe that read a fault as a
refusal would pass with no evidence, so the classes are checked by the markers
in the output, and a token need is never retried.

## Offline test

`scripts/test-probe-tokenless-attestation.sh` runs this probe against a stub gh,
with the caller exporting `GH_TOKEN` and `GITHUB_TOKEN`. It proves each
assertion fires on its mechanism and that the green case passes with no token.
