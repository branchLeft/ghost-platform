# Bootstrap runbook — `platform` stack, one time only

This stack has never been applied. Everything in it is a `create`.

Almost all of it is CI's job from now on, but CI cannot create the identity
it would need in order to run — so exactly one apply has to happen from a
workstation, under the platform owner's own credentials, and three grants
have to be made
by hand after it. That is what this runbook is. **It is run once.** After the
last step, every push to `main` applies this stack automatically and no local
`pulumi up` is ever needed again.

Two later sections are one-time bootstraps of the same kind and are numbered
separately: "Applying the provisioning credential" and "One-time bootstrap of
the tenant-provisioning identity". Neither recurs per tenant.

Run the steps in order. Steps 3 and 4 cannot be done before step 1, because
the service account they grant to does not exist until step 1 creates it.

Everything here is the platform owner's to run — §6 of the implementation-loop
skill puts the
first `pulumi up` for a stack, every project-level IAM binding, and every repo
settings change on the platform owner regardless of what rights the executing
identity holds.

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

```text
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

## Step 5 — point the workflow at the identity (repo settings)

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

## Applying the provisioning credential (one local apply, platform owner only)

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

### Part 2 — narrowing was attempted 2026-08-05 and is not achievable. Read this before trying again.

As created, `ghost_platform_provisioner` holds `cloudsqlsuperuser`: every
MySQL static privilege except SUPER and FILE, which means read/write/**drop**
on every tenant's database. This part of the runbook originally instructed
revoking that down to bare `CREATE USER`. A live attempt found that
unachievable, and produced a real incident (below) — **do not re-attempt
this without reading the whole section.**

**What actually happened, live, against the production instance:**

1. `REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'ghost_platform_provisioner'@'%';`
   (the statement this section used to specify) failed with
   `ERROR 3879 (HY000): Access denied ... to database 'sys'`. Cloud SQL
   reserves the `sys` schema even from `cloudsqlsuperuser`, and this
   blanket form of `REVOKE` enumerates it internally.
2. An explicit `REVOKE ... ON *.* FROM ...` (naming every static privilege
   except `CREATE USER`/`SUPER`/`FILE`) ran with no error but changed
   nothing — `SHOW GRANTS` confirmed the account holds those privileges only
   through membership of the `cloudsqlsuperuser` **role**, not as direct
   grants, so revoking direct privileges from the account is a no-op.
3. Revoking the role itself —
   `REVOKE `cloudsqlsuperuser`@`%` FROM 'ghost_platform_provisioner'@'%';` —
   **succeeded.** `SHOW GRANTS` dropped to bare `USAGE ON *.*`.
4. `GRANT CREATE USER ON *.* TO 'ghost_platform_provisioner'@'%';` — run
   immediately after, from the same still-connected session — failed:
   `ERROR 1045 (28000): Access denied for user 'ghost_platform_provisioner'@'%'`.
   Granting a privilege in MySQL requires holding it **with `GRANT OPTION`**.
   Nothing this account held, even as `cloudsqlsuperuser`, carried grant
   option on anything. This is not a permissions mistake in the runbook — no
   customer-facing Cloud SQL account (root included) holds `GRANT OPTION` on
   any privilege. Google's control plane is the only grantor. Confirmed live,
   not inferred from docs.
5. Net effect: step 3 left the account holding **no usable privilege at
   all**, with no SQL session reachable by a customer able to grant one back.
   A genuine self-lockout on a production credential, recovered (not
   designed around) as follows.

**Recovery used, and the only known way back:** recreate the account via the
Admin API, which re-runs Google's own provisioning path (the thing that
originally granted `cloudsqlsuperuser` and that no customer session can
invoke directly):

```bash
gcloud sql users delete ghost_platform_provisioner \
  --instance=ghost-platform-db --host=% --project=branchleft-prod --quiet
gcloud secrets versions access latest \
  --secret=ghost-platform-provisioner-db-password --project=branchleft-prod
gcloud sql users create ghost_platform_provisioner \
  --instance=ghost-platform-db --host=% --project=branchleft-prod \
  --password="<value from the command above>"
```

Same name/host/password as Pulumi's state, so `pulumi preview` still shows
no drift. Verified restored via `SHOW GRANTS` matching the original two-row
output (see Part 3).

**Decision: accept this credential at full `cloudsqlsuperuser` breadth.**
Narrowing it below that is not something any customer-accessible Cloud SQL
account can do via SQL — confirmed live, twice, by two different failure
modes. Re-attempting parts 1-4 above will not produce a different result.
This is a real, understood residual risk (the credential can read, write, or
drop any tenant's data), not a temporary gap:

- It is mitigated today only by **nothing consuming it** — no service
  account has `secretAccessor` on its Secret Manager entry, so there is no
  path from any running workload to this credential yet.
- Before any future story wires a consumer to it (e.g. a provisioning
  Cloud Function or CI job that runs the `ALTER USER ... WITH
  MAX_USER_CONNECTIONS` statement), that story must re-open this decision —
  options worth evaluating then include Cloud SQL IAM database
  authentication instead of a static password-holding role account, or
  further isolating *when* the credential is reachable (e.g. a short-lived
  Cloud Run Job invoked manually per tenant, rather than a standing secret).
  Do not treat "we already decided this is fine" as settled beyond the
  current state of zero consumers.

**Connecting to it at all — practical gotchas hit live, in case you're doing
this on Apple Silicon:** the published `cloud-sql-proxy` binary defaults to
`x86_64`; on an M-series Mac with no Rosetta it is silently `kill`ed with no
error output — download the `darwin.arm64` build instead. Homebrew's `mysql`
9.x client dropped the `mysql_native_password` plugin file entirely, which
this account's auth plugin needs — use `mariadb` (`brew install mariadb`)
with `--skip-ssl` (the proxy's local `127.0.0.1` hop is deliberately
plaintext; TLS happens inside the proxy's tunnel, and MariaDB's client
otherwise insists on it), or Docker's `mysql:8.0` image reaching the proxy
via `host.docker.internal` — **not** `--network host`, which is a no-op on
Docker Desktop for Mac and causes a same-container connection-refused error
that looks unrelated.

### Part 3 — verify current state

```sql
SHOW GRANTS FOR 'ghost_platform_provisioner'@'%';
```

**Expected — exactly two rows (the account's original, accepted, full-breadth
state):**

```text
GRANT USAGE ON *.* TO `ghost_platform_provisioner`@`%`
GRANT `cloudsqlsuperuser`@`%` TO `ghost_platform_provisioner`@`%`
```

If you see only the `USAGE` row, the account is currently locked out — run
the recovery command block above before doing anything else. Do not attempt
the narrowing sequence from Part 2 again; it will reproduce the same
lockout.

Rotation (bumping `rotationTag` in `provisioningUser.ts`) is also a local
apply: `cloudsql.users.update` is `cloudsql.admin`-only too.

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

## A human gate on top is not available on this plan

The `deploy` job declares `environment: platform`, and an earlier version of
this runbook said a required reviewer could be attached to it in repo
settings. **That is not true while this repo is private on the current plan,
and it should not be relied on.** GitHub documents required reviewers and wait
timers as public-repository-only for GitHub Free, Pro and Team alike; only
Enterprise offers them on a private repository. The org is on Free and this
repo is private, so the environment is a deployment-history label and nothing
more.

The same plan gap is already load-bearing elsewhere here and is confirmed
against the live API rather than inferred:

```bash
gh api /repos/branchLeft/ghost-platform/branches/main/protection
# 403 Upgrade to GitHub Pro or make this repository public to enable this feature.
```

Branch protection returns that. Environment protection has no equivalent
read-only probe — the environment object returns `protection_rules: []`
whether the rules are unsupported or merely unset — so the enforcement
question can only be settled by attempting to set one, which is a repo
settings change and therefore the platform owner's. The test is under
"Verifying the
environment gate" below.

What actually gates this stack is the Workload Identity provider's
`attributeCondition` and the roles the deployer does not hold, both of which
are enforced by GCP and unaffected by any GitHub plan.

---

## One-time bootstrap of the tenant-provisioning identity (platform owner only)

Prepared, not applied, and **blocked on one decision** — see "Verifying the
environment gate" at the end. Nothing below recurs per tenant.

The identity this creates is the most privileged thing in the project. It can
re-permission every principal in `branchleft-prod`, and once it holds
`roles/cloudsql.admin` it can clear the shared instance's deletion-protection
flag and delete the instance in the same session. Both halves are real and
neither is contained by any IAM Condition that can also create: a resource-name
condition in `projects/-/serviceAccounts/<unique-id>` form scopes administration
of an account that already exists and refuses to create one, and no attribute
describes *which role* a project-level policy write hands out.

### P1 — the service account

```bash
gcloud iam service-accounts create ghost-tenant-provisioner \
  --project=branchleft-prod \
  --display-name="Ghost platform - tenant provisioning identity"
```

Named apart from `ghost_platform_provisioner`, the MySQL account
`provisioningUser.ts` creates. Different things, different blast radii; they
should not read alike in a listing.

### P2 — federation, pinned to one workflow file rather than one environment

```bash
gcloud iam workload-identity-pools providers create-oidc tenant-provisioning \
  --project=branchleft-prod \
  --location=global \
  --workload-identity-pool=ghost-platform-gha \
  --display-name="Tenant provisioning" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition='assertion.repository == "branchLeft/ghost-platform" && assertion.job_workflow_ref == "branchLeft/ghost-platform/.github/workflows/provision-tenant.yml@refs/heads/main" && assertion.event_name == "workflow_dispatch"'
```

A second provider in the pool `workloadIdentity.ts` already declares. Pools are
free and a provider does not appear in the pool resource, so this does not
collide with that stack's state.

`job_workflow_ref` rather than the environment name alone: the `sub` claim
carries `environment:<name>` only because a job declared that environment, and
on this plan any job may declare any environment. Pinning the workflow file at
`main` plus `workflow_dispatch` is what a routine push cannot satisfy, and it
is enforced by GCP rather than by GitHub. The cost is that renaming that
workflow file silently breaks provisioning.

```bash
gcloud iam service-accounts add-iam-policy-binding \
  ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com \
  --project=branchleft-prod \
  --role="roles/iam.workloadIdentityUser" \
  --member="principal://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/ghost-platform-gha/subject/repo:branchLeft/ghost-platform:environment:tenant-provisioning"
```

`principal://.../subject/...` — the exact subject, not
`principalSet://.../attribute.repository/...`, which would admit every job in
the repo. Read `<project-number>` from
`gcloud projects describe branchleft-prod --format='value(projectNumber)'`.

### P3 — identity administration

```bash
for ROLE in roles/iam.serviceAccountAdmin \
            roles/iam.workloadIdentityPoolAdmin \
            roles/resourcemanager.projectIamAdmin; do
  gcloud projects add-iam-policy-binding branchleft-prod \
    --member="serviceAccount:ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com" \
    --role="$ROLE" --condition=None
done
```

Unconditioned, deliberately. A conditioned `serviceAccountAdmin` grant cannot
create, and creating tenant deployers is the whole job.

### P4 — `roles/cloudsql.admin`, withheld

**Do not run this until the provisioning plan guard is merged.**

```bash
# gcloud projects add-iam-policy-binding branchleft-prod \
#   --member="serviceAccount:ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com" \
#   --role="roles/cloudsql.admin" --condition=None
```

`cloudsql.users.create` exists only in this role, and the role also carries
`cloudsql.instances.{update,delete}` on the one instance every tenant's data
sits on. `database.ts`'s two deletion-protection flags do not stop it: the same
role can clear the API-level flag first. The compensating control is a plan
guard on every apply this identity makes, built from
`scripts/assert-no-platform-deletes.py`'s protected set rather than the
tenant-side one — `ghost-platform-db` appears nowhere in
`assert-no-tenant-deletes.py`, correctly, because a tenant program never
declares the instance. The guard must key on replacements as well as deletes;
the platform script already does.

Worth measuring before accepting the grant unconditioned: whether
`cloudsql.users.create` authorises against the instance resource rather than
the project, which would make an instance-scoped condition possible. Untested.
Test it on a fresh principal holding one binding, with a second fresh principal
on `expression=true` as a positive control in the same window — a revocation
propagates more slowly than a grant, so a reused principal reports the
condition before it.

### P5 — key and bucket access

```bash
gcloud kms keys add-iam-policy-binding pulumi-secrets \
  --keyring=pulumi --location=europe-west1 --project=branchleft-prod \
  --member="serviceAccount:ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com" \
  --role="roles/cloudkms.admin"

gcloud iam roles create ghostPlatformStateBucketAdmin \
  --project=branchleft-prod \
  --title="Ghost platform state bucket admin" \
  --description="Create per-tenant Pulumi state buckets and manage their IAM. No object access." \
  --permissions=storage.buckets.create,storage.buckets.get,storage.buckets.getIamPolicy,storage.buckets.setIamPolicy \
  --stage=GA

gcloud projects add-iam-policy-binding branchleft-prod \
  --member="serviceAccount:ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com" \
  --role="projects/branchleft-prod/roles/ghostPlatformStateBucketAdmin" --condition=None

gcloud storage buckets add-iam-policy-binding gs://branchleft-pulumi-state \
  --member="serviceAccount:ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

`cloudkms.admin` at key scope, never project scope. The custom role instead of
a predefined storage role because every predefined one that carries
`buckets.setIamPolicy` also reaches object contents; `storage.buckets.create`
exists only at project scope, so it cannot be narrowed further.

The last binding is for the provisioning stack's *own* state in the shared
bucket. Object access to each tenant's bucket is granted by the provisioning
program as it creates that bucket, not here.

### P6 — the package-read token

One platform-held classic PAT with `read:packages`, copied by the provisioning
workflow into every generated repo. Not one per tenant: GitHub Packages accepts
only classic PATs and no API mints one, so a per-tenant token is unavoidably a
per-tenant manual step — the exact thing this design exists to remove.

The cost, accepted knowingly: a classic PAT cannot be scoped to one repository,
so this token reads every package the creating account can reach, and its
compromise reaches every tenant repo at once.

Create it at Settings → Developer settings → Personal access tokens → Tokens
(classic), scope `read:packages`, **90-day expiry — not "no expiration"**, then:

```bash
gh secret set GH_PAT_GHOST_PLATFORM_READ --repo branchLeft/ghost-platform --body "<the PAT>"
```

Repo-level, not org-level: org secrets are invisible to private repos on this
plan and resolve to an empty string with no error.

**Rotation, every 90 days.** Mint the replacement before revoking the old one,
then fan it out:

```bash
gh secret set GH_PAT_GHOST_PLATFORM_READ --repo branchLeft/ghost-platform --body "<new PAT>"
for REPO in $(gh repo list branchLeft --limit 100 --json name --jq '.[].name'); do
  if gh secret list --repo "branchLeft/$REPO" 2>/dev/null | grep -q GH_PAT_GHOST_PLATFORM_READ; then
    gh secret set GH_PAT_GHOST_PLATFORM_READ --repo "branchLeft/$REPO" --body "<new PAT>"
  fi
done
```

Discovering the fan-out set by reading which repos hold the secret, rather than
from a list someone maintains, is deliberate: a tenant repo missed by a stale
list fails at `npm ci` on its next run, loudly but well after the rotation
looked done. Revoke the old token only once the loop has run and one tenant
repo's CI has passed on the new one.

The whole step disappears when this repo goes public — a public package needs
no token.

### P7 — the roles the tenant's first apply needs

P1–P6 cover creating a tenant's *identity*. They do not cover running that
tenant's first apply, which is the other half of what this identity is for —
the posture is that CI updates and never bootstraps, so a tenant deployer
holds `cloudsql.editor` and cannot create its own database user, and the
bootstrapper becomes this identity instead of a person.

Derived from what a `GhostTenant` instantiation actually declares, not from
role names:

| Resource | Permission | Covered by |
|---|---|---|
| `gcp.serviceaccount.Account` (runtime SA) | `iam.serviceAccounts.create` | P3 |
| `deployer-can-act-as-<tenant>-sa` | `iam.serviceAccounts.setIamPolicy` | P3 |
| `gcp.projects.IAMMember` (conditional `cloudsql.client`) | `resourcemanager.projects.setIamPolicy` | P3 |
| `gcp.sql.Database`, `gcp.sql.User` | `cloudsql.{databases,users}.create` | **P4, withheld** |
| `gcp.secretmanager.Secret` / `SecretVersion` / `SecretIamMember` ×4 | `secretmanager.secrets.create`, `.versions.add`, `.setIamPolicy` | `roles/secretmanager.admin` |
| `gcp.storage.HmacKey` | `storage.hmacKeys.create` | `roles/storage.hmacKeyAdmin` |
| `gcp.storage.BucketIAMMember` ×2 on the media bucket | `storage.buckets.setIamPolicy` | bucket-scoped grant on the media bucket |
| `gcp.cloudrunv2.Service` | `run.services.create` | `roles/run.developer` |
| `gcp.cloudrunv2.ServiceIamMember` (public invoker) | `run.services.setIamPolicy` | `roles/run.admin` |

```bash
for ROLE in roles/secretmanager.admin roles/storage.hmacKeyAdmin roles/run.admin; do
  gcloud projects add-iam-policy-binding branchleft-prod \
    --member="serviceAccount:ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com" \
    --role="$ROLE" --condition=None
done

gcloud storage buckets add-iam-policy-binding gs://branchleft-prod-ghost-platform-media \
  --member="serviceAccount:ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com" \
  --role="roles/storage.legacyBucketOwner"
```

`run.admin` rather than `run.developer`: the public invoker binding needs
`run.services.setIamPolicy`, which developer does not hold. The media bucket
grant is bucket-scoped for the same reason the platform deployer's is — a
project-level storage role would reach the Pulumi state buckets.

**This list is derived, not measured.** Confirm it with a `pulumi preview`
under this identity against a scratch tenant stack before treating it as
complete; a missing role surfaces as a 403 partway through an apply, which on
a first apply leaves a half-created tenant. Add whatever the preview turns up
here rather than granting a wider role to make the error go away.

Stated plainly, because the total is easy to lose across seven headings: this
identity ends up holding service-account administration, project IAM
administration, workload-identity-pool administration, Secret Manager
administration, Cloud Run administration, HMAC key administration, KMS
administration on the stack key, and — once P4 lands — full Cloud SQL
administration on the instance every tenant's data sits on. It is
project-admin in all but name. What makes that acceptable is not its size but
its reachability: nothing on a routine code path can assume it. If that stops
being true, this bootstrap needs redoing, not patching.

### Verifying the environment gate — this is the blocker

The design puts the provisioning workflow behind a GitHub environment with a
required reviewer. **On GitHub Free with a private repository that protection
is documented as unavailable**, and this org has already been caught twice by
the same class of gap (org secrets invisible to private repos; branch
protection 403). It has not been verified live, because doing so is a repo
settings change.

Settle it before building the workflow:

```bash
OWNER_ID=$(gh api /users/Rob-branchLeft --jq .id)
printf '{"reviewers":[{"type":"User","id":%s}]}' "$OWNER_ID" \
  | gh api -X PUT /repos/branchLeft/ghost-platform/environments/tenant-provisioning --input -
```

The nested array will not survive `gh api -f`/`-F`, hence `--input`. This
creates the environment if it does not exist, so it is the setup step and the
test in one.

- **Rejected (422/403 naming the plan)** — the gate does not exist. The
  workflow must not be written as though it does; the options are making this
  repo public, GitHub Enterprise (Team and Pro do not carry it either), or
  accepting `workflow_dispatch` on a write-access-only repo as the gate, which
  is what P2's `attributeCondition` is already shaped for.
- **Accepted** — read it back and then prove it enforces, rather than trusting
  the write:

  ```bash
  gh api /repos/branchLeft/ghost-platform/environments/tenant-provisioning \
    --jq '.protection_rules'
  ```

  A `required_reviewers` entry must be present. Then run any workflow job that
  declares `environment: tenant-provisioning` and confirm the run *waits*. A
  configured rule that does not pause the run is the failure mode worth
  catching — it looks like a gate in every listing and gates nothing.
