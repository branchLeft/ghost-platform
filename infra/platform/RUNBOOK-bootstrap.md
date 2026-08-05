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

**Without this the deployer has no access to the state bucket at all**, and
every CI run fails at `pulumi login` with the 403 quoted in
`website/infra/KNOWN_ISSUES.md` under "`github-actions-deployer` SA needs
manual IAM on the Pulumi state bucket". It is the same trap, in the same
shape: Pulumi cannot grant itself access to the bucket it must log in to
*before* it can grant anything, so this binding can never come from the
program.

This is a bucket-scoped grant on purpose, and `serviceAccounts.ts` gives the
deployer no project-level storage role that would shortcut it. That is
deliberate: `gs://branchleft-pulumi-state` is the only bucket in
`branchleft-prod` and it holds the state for four stacks, two of them owned
by other repos (`branchleft-website-infra`, `branchleft-shared-infra`), so a
project-level storage role here would let this repo's CI corrupt the website
and shared-edge stacks' state. `roles/storage.objectAdmin` on this one bucket
is exactly what `website/infra`'s deployer holds, and no more.

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

## Applying the provisioning credential (one local apply, Rob-only)

`provisioningUser.ts` adds a `gcp.sql.User` and a Secret Manager secret. **CI
cannot create either**, and this is verified, not assumed:

- `cloudsql.users.create` exists only in `roles/cloudsql.admin`. The deployer
  holds `roles/cloudsql.editor`, which has `cloudsql.users.{get,list}` and
  nothing that writes. Granting `cloudsql.admin` to fix that would also hand
  CI `cloudsql.instances.delete` — the one permission this stack's identity
  design exists to withhold. Not done.
- The deployer holds no `secretmanager.*` permission at all.

So the first apply of that file is **yours, locally**. It is a **three-part
step and all three parts are mandatory** — part 2 is what stops this being a
root-equivalent credential, and it is not optional or deferrable to a later
story. Do not walk away between 1 and 3.

### Do this immediately after merging the PR, before anything else lands

CI applies this stack on **every** push to `main`, with no path filter. So
from the moment the PR merges, the *next* merge to `main` — any merge, even
one that touches nothing here — triggers a deploy that 403s on
`cloudsql.users.create` and fails. It is loud, not silent, and nothing is left
half-applied on the GCP side (the `Secret` `dependsOn` the `sql.User`, so a
failed user creation means no secret either; only the `RandomPassword`, which
is generated locally and calls no API, lands in state). But it will block
unrelated work until you run part 1. Treat "merge PR" and "run part 1" as one
action.

### Part 1 — create the account and the secret

```bash
cd infra/platform
pulumi preview --stack platform        # expect: 5 creates, 0 updates, 0 deletes
pulumi up --stack platform
```

Once those resources are in state, CI's `pulumi up` runs **without
`--refresh`** (see `.github/workflows/infra-platform-ci.yml`), so it diffs
against state, not live GCP, and makes no Cloud SQL or Secret Manager API
call against them. No new deployer role is needed and none is added.

### Part 2 — narrow it (mandatory, this is not a later improvement)

As created, `ghost_platform_provisioner` holds `cloudsqlsuperuser`: every
MySQL static privilege except SUPER and FILE, which means read/write/**drop**
on every tenant's database. The Cloud SQL Admin API has no flag to create it
narrower (`gcloud sql users create --help` has no privilege or role argument
at all), so the only route to a narrow credential is to revoke immediately
after creation. `provisioningUser.ts`'s header has the full analysis.

Start the Cloud SQL Auth Proxy in one terminal — **not `gcloud sql connect`**,
which temporarily adds your IP to `authorizedNetworks` and so shows up as
drift on the next `pulumi preview`:

```bash
cloud-sql-proxy branchleft-prod:europe-west1:ghost-platform-db --port 3306
```

In another, read the password and connect as the new user:

```bash
gcloud secrets versions access latest \
  --secret=ghost-platform-provisioner-db-password --project=branchleft-prod
mysql -h 127.0.0.1 -P 3306 -u ghost_platform_provisioner -p
```

Then, in that MySQL session:

```sql
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'ghost_platform_provisioner'@'%';
GRANT CREATE USER ON *.* TO 'ghost_platform_provisioner'@'%';
```

`CREATE USER` is the single privilege that authorises
`ALTER USER ... WITH MAX_USER_CONNECTIONS`, and it carries no data access
whatsoever. The account can still do its one job and can no longer read a
single tenant row.

### Part 3 — verify, and record that you did

```sql
SHOW GRANTS FOR 'ghost_platform_provisioner'@'%';
```

**Expected — exactly one row:**

```
GRANT CREATE USER ON *.* TO `ghost_platform_provisioner`@`%`
```

If you see `ALL PRIVILEGES`, or a `cloudsqlsuperuser` role row, part 2 did not
take. Re-run it. Do not leave the instance in that state.

This query is the gate, not this document. **No future story, job, script or
person may treat this credential as safe to reference until `SHOW GRANTS`
returns that one row.** Pulumi cannot enforce it — grants live behind a SQL
connection that no `gcp.*` resource and no CI job here can open — so the
control is that the check is one read-only query anyone can run in ten
seconds, and that it is the documented precondition for using the credential
at all.

Rotation (bumping `rotationTag` in `provisioningUser.ts`) is also a local
apply: `cloudsql.users.update` is `cloudsql.admin`-only too. The narrowing
survives rotation — changing a password does not restore grants — so parts 2
and 3 do not need repeating.

No service account has `secretAccessor` on the secret. That is deliberate —
nothing consumes it yet, so the grant would open an access path with no user.

---

## After this: what changes, and what does not

**Automatic from now on.** Any merge to `main` that changes `database.ts`,
`registry.ts`, `mediaBucket.ts`, `apis.ts` or `config.ts` is applied by CI.
No local `pulumi up`. No manual step.

**Two things CI deliberately cannot do, both of which need you.** The
deployer holds `roles/cloudsql.editor` (not admin) and a bucket-scoped
`roles/storage.legacyBucketOwner` (not a project storage role), so it has
neither `cloudsql.instances.{create,delete}` nor `storage.buckets.{create,
delete}`. A change that *replaces* the database or the media bucket — an
immutable field like `region`, say — 403s in CI rather than applying. That
is the intent: replacing either is a data migration, not a merge. Run it
locally, having read the plan, exactly as in step 1.

**Only `main` can authenticate.** The Workload Identity provider's condition
requires `assertion.ref == "refs/heads/main"` as well as the repository, so a
workflow run from any other branch cannot exchange a token at all. If a
pull-request `pulumi preview` job is added later, it needs its own provider
in the same pool and its own (read-only) service account — do not widen this
condition to make a preview job work.

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
