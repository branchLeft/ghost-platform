# Bootstrap runbook — `platform` stack, one time only

This stack has never been applied. Everything in it is a `create`.

Almost all of it is CI's job from now on, but CI cannot create the identity
it would need in order to run — so exactly one apply has to happen from a
workstation, under Rob's own credentials, and three grants have to be made
by hand after it. That is what this runbook is. **It is run once.** After the
last step, every push to `main` applies this stack automatically and no local
`pulumi up` is ever needed again.

Run the steps in order. Steps 3 and 4 cannot be done before step 1, because
the service account they grant to does not exist until step 1 creates it.

Everything here is Rob's to run — §6 of the implementation-loop skill puts the
first `pulumi up` for a stack, every project-level IAM binding, and every repo
settings change on Rob regardless of what rights the executing identity holds.

---

## Before you start

```bash
gcloud auth application-default login
gcloud config set project branchleft-prod
```

Confirm you are the right identity — the whole reason step 1 works at all is
that this account can grant IAM that the deployer service account never will
be able to:

```bash
gcloud config get-value account   # expect rob@branchleft.co.uk
```

---

## Step 1 — the one local apply

```bash
cd infra/platform
npm ci
pulumi login gs://branchleft-pulumi-state
pulumi preview --stack platform
pulumi up --stack platform
```

**Read the preview before answering yes.** As of this runbook it is 19
creates and nothing else — the six API enablements, the Cloud SQL instance,
the Artifact Registry repository, the media bucket and its public-read
binding, plus the seven new CI-identity resources this story adds.

This single apply creates both the infrastructure *and* the identity CI will
use, in one pass, with no chicken-and-egg. That works only because *your*
account is doing the granting: the four `gcp:projects:IAMMember` resources
need `resourcemanager.projects.setIamPolicy`, which you have and the deployer
service account deliberately never will.

**This is the moment recurring spend starts** — roughly $9.50–9.80/month, all
of it from the Cloud SQL instance and its storage. The itemised, live-SKU
breakdown is in PR #2's body; nothing in this story adds to it (a Workload
Identity pool, a provider, a service account and IAM bindings are all free).

---

## Step 2 — record the two values CI needs

```bash
pulumi stack output githubActionsWorkloadIdentityProvider
pulumi stack output githubActionsDeployerServiceAccountEmail
```

Expected shapes:

```
projects/<project-number>/locations/global/workloadIdentityPools/ghost-platform-gha/providers/github
ghost-platform-deployer@branchleft-prod.iam.gserviceaccount.com
```

Keep the first one to hand for step 5. It is not committed anywhere in this
repo because it embeds the GCP project number.

---

## Step 3 — let the deployer decrypt this stack's secrets provider (gcloud only)

```bash
gcloud kms keys add-iam-policy-binding pulumi-secrets \
  --keyring=pulumi \
  --location=europe-west1 \
  --project=branchleft-prod \
  --member="serviceAccount:ghost-platform-deployer@branchleft-prod.iam.gserviceaccount.com" \
  --role="roles/cloudkms.cryptoKeyEncrypterDecrypter"
```

**Do not skip this, and do not try to move it into the Pulumi program.**

`Pulumi.platform.yaml` sets `secretsprovider:
gcpkms://projects/branchleft-prod/locations/europe-west1/keyRings/pulumi/cryptoKeys/pulumi-secrets`
and carries an `encryptedkey`. Pulumi decrypts that data key every time it
loads the stack, before it does anything else — so without this binding the
CI job fails at `pulumi preview`, on the very first run, with a KMS permission
error and nothing applied.

`website/infra/KNOWN_ISSUES.md` ("Pulumi stack secrets are encrypted with a
Cloud KMS key — bootstrap it via `gcloud`, not Pulumi") records why this is a
`gcloud` grant permanently and not just for bootstrap: declaring it as a
`gcp.kms.CryptoKeyIAMMember` fails with `Permission
'cloudkms.cryptoKeys.getIamPolicy' denied`, and the only role that would fix
that is `roles/cloudkms.admin` — which would let the deploy pipeline rewrite
who is allowed to decrypt its own secrets. That is precisely the control the
key exists to provide.

Verify:

```bash
gcloud kms keys get-iam-policy pulumi-secrets \
  --keyring=pulumi --location=europe-west1 --project=branchleft-prod \
  --format=json | grep ghost-platform-deployer
```

---

## Step 4 — let the deployer read and write the Pulumi state bucket (gcloud only)

```bash
gcloud storage buckets add-iam-policy-binding gs://branchleft-pulumi-state \
  --member="serviceAccount:ghost-platform-deployer@branchleft-prod.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

This is the trap `website/infra/KNOWN_ISSUES.md` describes under
"`github-actions-deployer` SA needs manual IAM on the Pulumi state bucket":
Pulumi cannot grant itself access to the bucket it must log in to *before* it
can grant anything, so the binding can never come from the program.

**One honest correction to that framing, for this stack specifically.** It is
not strictly irreducible here, and the runbook should not claim otherwise.
`serviceAccounts.ts` grants the deployer `roles/storage.admin` at *project*
level (it needs `storage.buckets.setIamPolicy` for the media bucket's
public-read binding), and `gs://branchleft-pulumi-state` lives in
`branchleft-prod` — verified, not assumed: the `projectNumber` reported by
`gcloud storage buckets describe gs://branchleft-pulumi-state --raw` matches
the one `gcloud projects describe branchleft-prod` reports. So step 1 has, as
a side effect, already given the deployer everything it needs on the state
bucket.

Run step 4 anyway. Two reasons:

1. It makes the dependency explicit. Right now CI's ability to reach its own
   state rests on an incidental consequence of a role granted for an
   unrelated reason. The day someone narrows `roles/storage.admin` — a
   sensible thing to want to do — every deploy breaks at `pulumi login`, and
   nothing in the diff that caused it will look related.
2. It is idempotent and free.

Verify:

```bash
gcloud storage buckets get-iam-policy gs://branchleft-pulumi-state \
  --format=json | grep ghost-platform-deployer
```

---

## Step 5 — point the workflow at the identity (Rob-gated: repo settings)

```bash
gh variable set GCP_PROJECT_ID \
  --repo branchLeft/ghost-platform \
  --body "branchleft-prod"

gh variable set GCP_DEPLOYER_SA_EMAIL \
  --repo branchLeft/ghost-platform \
  --body "ghost-platform-deployer@branchleft-prod.iam.gserviceaccount.com"

# Paste the value step 2 printed.
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER \
  --repo branchLeft/ghost-platform \
  --body "projects/<project-number>/locations/global/workloadIdentityPools/ghost-platform-gha/providers/github"
```

Verify all three are set, since a missing one fails in an unhelpful way (the
auth step receives an empty string and reports a malformed provider):

```bash
gh variable list --repo branchLeft/ghost-platform
```

---

## Step 6 — confirm CI has actually taken over

Merging the PR that adds this runbook is itself the test: it pushes to `main`,
which runs the `deploy` job.

```bash
gh run list --repo branchLeft/ghost-platform --workflow "Platform infra CI" --limit 3
gh run view --repo branchLeft/ghost-platform <run-id> --log-failed
```

A healthy first CI run does the whole sequence and finds nothing to do —
`pulumi up` reporting `Resources: 19 unchanged` is the success condition,
because step 1 already applied everything. That is the point: it proves the
federation, the KMS grant, the state-bucket access and all four project roles
work, without changing anything.

**A green run is not by itself proof the deploy did anything.** If the job is
skipped — wrong branch, workflow file not on `main` yet — GitHub reports the
overall run as successful. Check that the `Deploy (pulumi up)` job actually
ran and look at its job summary, don't just look for a green tick.

---

## After this: what changes, and what does not

**Automatic from now on.** Any merge to `main` that changes `database.ts`,
`registry.ts`, `mediaBucket.ts`, `apis.ts` or `config.ts` is applied by CI.
No local `pulumi up`. No manual step.

**Still yours, and it will fail loudly rather than silently.** A change to
`workloadIdentity.ts`, or to the `projectRoles` list in `serviceAccounts.ts`,
cannot be applied by CI: the deployer holds no
`resourcemanager.projects.setIamPolicy`, no `iam.workloadIdentityPoolAdmin`
and no `iam.serviceAccountAdmin`, all deliberately (the reasoning is in
`serviceAccounts.ts`). CI 403s on the resource, and because a failed resource
aborts the whole update, everything else in that run is blocked too.

The recovery is the pattern `website/infra/KNOWN_ISSUES.md` already
prescribes:

```bash
# 1. Grant by hand, as yourself.
gcloud projects add-iam-policy-binding branchleft-prod \
  --member="serviceAccount:ghost-platform-deployer@branchleft-prod.iam.gserviceaccount.com" \
  --role="roles/<the-new-role>" --condition=None

# 2. Adopt it into state, so CI's next run sees no change to make.
pulumi import --stack platform \
  gcp:projects/iAMMember:IAMMember deployer-<name> \
  "branchleft-prod roles/<the-new-role> serviceAccount:ghost-platform-deployer@branchleft-prod.iam.gserviceaccount.com"
```

Then merge. Never let CI be the thing that first tries to create a
project-level binding.

**A change that would replace or delete the database, the media bucket, the
image repository or the CI identity** is blocked before `pulumi up` runs, by
`scripts/assert-no-platform-deletes.py`. That is intended: those are
migrations, not merges. If one is genuinely wanted, it is a local apply under
your own credentials with the plan read line by line, not a PR.

---

## Optional: add a human gate on top

The `deploy` job declares `environment: platform`. Attaching a required
reviewer to that environment in repo settings would make every apply wait for
an approval click.

Not configured, because it partly undoes the thing being asked for — "CI owns
this, no more manual applies". The four guardrails listed at the top of
`.github/workflows/infra-platform-ci.yml` are what replaced the manual step,
and a reviewer prompt on a stack that changes a few times a year mostly
trains people to click through it. Worth reconsidering if this stack starts
changing often, or once real tenant data is on the instance.

If wanted: repo Settings → Environments → `platform` → Required reviewers.
