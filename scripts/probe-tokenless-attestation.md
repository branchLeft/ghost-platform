# probe-tokenless-attestation.sh

## What this does

Checks that the image verifier works the way a host runs it: with `GH_TOKEN` set
to one fixed placeholder string and nothing else. It calls
`scripts/verify-image-attestation.sh` and never restates its logic, so the gh
flags and values are those of that one script. The host verifier in
shared-infra PR 665 is being changed to set the same placeholder; this job
proves the behaviour on a hosted runner.

```sh
./scripts/probe-tokenless-attestation.sh <real image@sha256:64hex> <forged image@sha256:64hex>
```

The probe runs four checks, in order:

1. **Environment proof.** Under the scrubbed environment, `GH_TOKEN` is the
   literal `placeholder-not-a-credential`, `GITHUB_TOKEN`,
   `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` are unset, and the gh
   config directory has no hosts file. Anything else fails with
   `ASSERT FAILED: probe environment`. The placeholder is fixed in the script and
   is not read from the caller, so no real token can reach the verifier.
2. **API evidence.** One extra call on the real digest runs with
   `GH_DEBUG=api`, kept apart from the output the verdicts are read from, and
   prints how many requests gh logged to `api.github.com` and which hosts it
   logged.
3. **Real digest.** The verifier runs with `--bundle-from-oci`. Success prints
   `VERIFIED with a placeholder GH_TOKEN; no GitHub API call observed` (or the
   count, if the evidence call logged any). A token need fails with
   `ASSERT FAILED: verification needs a GitHub token`. A network or Sigstore
   fault is retried three times, 20 seconds apart, then fails as a fault, not a
   verdict. Anything else fails as a refusal for the attestation or identity.
4. **Control.** The same call on the forged digest, a real attestation from a
   different workflow, must exit non-zero, and not because of a token need or a
   network fault. The probe also requires gh's policy wording or the script's
   `no valid attestation for` line, which the script prints on any gh failure,
   so that line alone does not name the cause. An acceptance fails with
   `ASSERT FAILED: forged digest accepted: the probe is vacuous`. The control
   differs from the real digest in its signer workflow. `--source-ref` and
   `--deny-self-hosted-runners` have no control of their own here.

The scrubbed environment copies the host's keys by hand: `PATH`, `HOME`,
`GH_CONFIG_DIR` and `XDG_CONFIG_HOME` (all an empty directory),
`GH_PROMPT_DISABLED`, `GH_NO_UPDATE_NOTIFIER`, `LC_ALL=C`,
`VERIFY_PLAIN_ERRORS=1` and the placeholder `GH_TOKEN`. Keep them in step with
the host's function.

## What the first runs found

Token-less is not possible, and a placeholder is enough.

- [Run 42427972700](https://github.com/branchLeft/ghost-platform/actions/runs/42427972700):
  with no `GH_TOKEN` at all, gh 2.103.3 refused on the real digest with
  `To get started with GitHub CLI, please run:  gh auth login`, before any
  network call. Red.
- [Run 42428728854](https://github.com/branchLeft/ghost-platform/actions/runs/42428728854):
  with `GH_TOKEN=placeholder-not-a-credential`, the real digest verified, and the
  forged digest was refused with `no valid attestation for ... from
  branchLeft/ghost-platform/.github/workflows/registry-push.yml on refs/heads/main`.
  Green. The `GH_DEBUG=api` call logged 22 requests, 9 to
  `tuf-repo-cdn.sigstore.dev` and 13 to `tuf-repo.github.com`, none to
  `api.github.com`, and no Authorization header.

So gh's local gate takes any non-empty `GH_TOKEN` on the `--bundle-from-oci`
path, and the verdict is cryptographic. This job stands as the proof that a real
token is not required. The debug log covers gh's own HTTP client only, not its
registry reads.

## Why the classes are split

A token need, a transport fault and a refusal of the attestation all make gh
exit non-zero. Only the refusal is a verdict. A probe that read a fault as a
refusal would pass with no evidence, so the classes are checked by the markers
in the output, and a token need is never retried. gh's debug text names TUF, so
it is kept out of the output the classes are read from.

## Offline test

`scripts/test-probe-tokenless-attestation.sh` runs this probe against a stub gh,
with the caller exporting stand-ins for real credentials. It proves each
assertion fires on its mechanism and that the green case sees only the
placeholder.
