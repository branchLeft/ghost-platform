# Private tenant plan register

`private-tenant-plan.json` is the single home of the owner's attestation that a
private tenant repository may be provisioned. The provisioning gate,
`infra/provisioning/scripts/check_private_tenant_plan.py`, is the only code that
reads it. The workflow `.github/workflows/provision-tenant.yml` calls the gate and
parses nothing itself.

It ships with both booleans `false`. A private tenant is refused until the owner
flips each one in a reviewed pull request.

## What each field attests

| Field | Set to `true` only when |
|---|---|
| `paid_plan_confirmed` | The organisation holds a paid GitHub plan that gives private repositories environment required reviewers and repository rulesets. On a free plan those features are not available on a private repository. |
| `dedicated_runner_confirmed` | A dedicated Hetzner virtual machine is running as the CI runner for private repositories, and it carries the label named in `dedicated_runner_label`. |
| `dedicated_runner_label` | The runner label that the dedicated VM registers under. It must start with `private-ci-hetzner`, so the attestation is pinned to a Hetzner runner. |

Both attestations are the owner's spend. An agent does not procure either one and
does not set either flag. The flag is an owner decision recorded in a reviewed
pull request.

**A personal Mac never qualifies as the dedicated runner.** The owner's own
machine is not a private-CI runner. Setting `dedicated_runner_confirmed` to `true`
for it is a misattestation, and no check in this repository can detect that.

## Ruling this rests on

The owner's ruling of 31 October 2026 keeps the private-tenant capability behind
a gate. The gate refuses unless a paid GitHub plan and a dedicated Hetzner
private-CI runner are both in place. Both readings are literal and both are
required. If either one is missing the run refuses.

## What the owner-only guarantee depends on

The register is the owner's, and only the owner should be able to change it. That
guarantee rests on two controls outside this file:

1. Code-owner review on `main`. `.github/CODEOWNERS` assigns this file to
   `@branchLeft/branchleft-admin`. Changes reach `main` only through a reviewed
   pull request.
2. The `tenant-provisioning` environment's deployment-branch policy. A dispatch
   runs against a branch, and the policy stops a branch other than `main` from
   reaching the environment's secrets. A dispatch from a branch therefore cannot
   carry an edited register into a run.

If either control is loosened, the register can be edited inside a run and the
gate reads the edited copy. Neither control is checked by this file.

## What is caught, and what is not

- A stale attestation is caught only by the read-backs in the workflow. After the
  gate passes, the workflow reads the production environment's required reviewer
  and the default branch's rules back from GitHub, and stops if either is missing.
  Those read-backs fail closed. A plan that has lapsed produces a missing reviewer
  or a missing ruleset, and the run stops before any state credential is written.
- Nothing re-verifies that the runner virtual machine exists or is healthy. The
  attestation is accepted on the owner's word. This is a named limit.
- The gate does not check the runner's label against a live runner list. An
  organisation-level runners read is outside the provisioning App's scope, and
  granting that scope is a separate owner decision.

## Not covered

- Existence of the dedicated runner virtual machine is attested, not verified.
- The tenant repository template does not yet select the dedicated runner label
  for a private tenant. Until it does, a private tenant's own CI cannot run on the
  dedicated runner even when the gate passes.
- The gate does not verify the paid plan. The read-backs are the runtime proof.
