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

## The human gate, and why it depends on this repo being public

The `deploy` job declares `environment: platform`, and an earlier version of
this runbook said a required reviewer could be attached to it in repo
settings. **That is true only once this repo is public.** GitHub documents
required reviewers and wait timers as public-repository-only for GitHub Free,
Pro and Team alike; only Enterprise carries them on a private repository.

The same plan gap is already load-bearing elsewhere here and is confirmed
against the live API rather than inferred:

```bash
gh api /repos/branchLeft/ghost-platform/branches/main/protection
# while private: 403 Upgrade to GitHub Pro or make this repository public
```

There is no read-only probe that distinguishes "protection unsupported" from
"protection unset" — the environment object reports `protection_rules: []`
either way. The only conclusive test is attempting to set one, which is under
"Step V" below.

**An environment with no protection rules does not pause a run.** It is a
deployment record. Nothing warns you; the job simply executes. That is why the
ordering in the next section is load-bearing rather than tidy.

---

## One-time bootstrap of the tenant-provisioning identity (platform owner only)

Nothing here recurs per tenant. **Run the steps in the order given.** The
ordering is a control, not a convention: the WIF provider in P2 is the last
thing that can authenticate a provisioning run, so creating it last means
there is no window in which `provision-tenant.yml` can execute against an
unprotected environment. Creating it before the environment carries its
reviewer would open exactly that window, and nothing would report it — the run
would simply not pause.

The identity this creates can re-permission every principal in
`branchleft-prod`. That is not containable by any IAM Condition: a
resource-name condition in `projects/-/serviceAccounts/<unique-id>` form scopes
administration of an account that already exists and refuses to create one,
and no attribute describes *which role* a project-level policy write hands
out. What bounds it is reachability, which is what P0–P2 are for.

### P0 — flip the repo public, then create the gated environment

Both are settings operations and both precede everything else.

```bash
# 1. Public. Only after the pre-flip audit has cleared the repo and history.
gh repo edit branchLeft/ghost-platform --visibility public --accept-visibility-change-consequences

# 2. The environment, with the reviewer. This creates it and sets the rule in
#    one call; the nested array will not survive `gh api -f`/`-F`, hence --input.
OWNER_ID=$(gh api /users/Rob-branchLeft --jq .id)
printf '{"reviewers":[{"type":"User","id":%s}]}' "$OWNER_ID" \
  | gh api -X PUT /repos/branchLeft/ghost-platform/environments/tenant-provisioning --input -
```

### Step V — verify the gate before going further

Do not treat the write in P0 as proof. A rule that is configured but not
enforced looks identical in every listing and gates nothing.

```bash
gh api /repos/branchLeft/ghost-platform/environments/tenant-provisioning \
  --jq '.protection_rules'
```

A `required_reviewers` entry must be present. Then dispatch
`provision-tenant.yml` with throwaway inputs and confirm the run **waits for
approval instead of starting**:

```bash
gh workflow run provision-tenant.yml --repo branchLeft/ghost-platform \
  -f tenant_name=gate-test -f tenant_repo=gate-test -f state_bucket=gate-test \
  -f deployer_sa_id=gate-test -f wif_pool_id=gate-test \
  -f site_url=https://example.invalid -f image_digest_or_tag=none
gh run list --repo branchLeft/ghost-platform --workflow provision-tenant.yml --limit 1
```

Expected: status `waiting`. Reject the deployment rather than approving it.
This is safe to run before P1–P7 exist — with no WIF provider the job could
not authenticate even if approved, which is the interlock the ordering buys.

**If the run does not wait, stop.** The gate does not exist, and
`provision-tenant.yml` must not be dispatched again until it does.

### P1 — the service account

```bash
gcloud iam service-accounts create ghost-tenant-provisioner \
  --project=branchleft-prod \
  --display-name="Ghost platform - tenant provisioning identity"
```

Named apart from `ghost_platform_provisioner`, the MySQL account
`provisioningUser.ts` creates. Different things, different blast radii; they
should not read alike in a listing.

### P2 — federation, pinned to this one workflow file

**Last of the GCP steps.** Until this exists no provisioning run can
authenticate at all.

```bash
gcloud iam workload-identity-pools providers create-oidc tenant-provisioning \
  --project=branchleft-prod \
  --location=global \
  --workload-identity-pool=ghost-platform-gha \
  --display-name="Tenant provisioning" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition='assertion.repository == "branchLeft/ghost-platform" && assertion.job_workflow_ref == "branchLeft/ghost-platform/.github/workflows/provision-tenant.yml@refs/heads/main" && assertion.event_name == "workflow_dispatch"'

gcloud iam service-accounts add-iam-policy-binding \
  ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com \
  --project=branchleft-prod \
  --role="roles/iam.workloadIdentityUser" \
  --member="principal://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/ghost-platform-gha/subject/repo:branchLeft/ghost-platform:environment:tenant-provisioning"
```

A second provider in the pool `workloadIdentity.ts` already declares. Pools are
free and a provider does not appear in the pool resource, so this does not
collide with that stack's state.

`job_workflow_ref` rather than the environment name alone: the `sub` claim
carries `environment:<name>` only because a job declared that environment, and
any job may declare any environment. Pinning the workflow file at `main` plus
`workflow_dispatch` is what a routine push cannot satisfy, and Google enforces
it whatever GitHub's settings say — so it still holds if the environment rule
is ever removed. The cost is that renaming the workflow file breaks
provisioning until this condition is updated.

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

### P4 — Cloud SQL, by custom role. `roles/cloudsql.admin` is never granted.

```bash
gcloud iam roles create ghostPlatformTenantSqlProvisioner \
  --project=branchleft-prod \
  --title="Ghost tenant SQL provisioner" \
  --description="Create a tenant logical database and DB user on the shared instance. Cannot create, update or delete an instance, and cannot drop a database or user." \
  --permissions=cloudsql.databases.create,cloudsql.databases.get,cloudsql.databases.list,cloudsql.databases.update,cloudsql.users.create,cloudsql.users.get,cloudsql.users.list,cloudsql.users.update,cloudsql.instances.get,cloudsql.instances.list \
  --stage=GA

gcloud projects add-iam-policy-binding branchleft-prod \
  --member="serviceAccount:ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com" \
  --role="projects/branchleft-prod/roles/ghostPlatformTenantSqlProvisioner" --condition=None
```

This replaces the `roles/cloudsql.admin` grant the design assumed was
unavoidable, and with it the condition that a plan guard had to ship alongside
that grant. Two measurements against the live project settled it.

**An instance-scoped IAM condition cannot contain this, so scoping was not the
answer.** `roles/cloudsql.admin` conditioned on the shared instance's resource
name — all four plausible spellings in one disjunction — denied creating a
user on that very instance, identically to a condition naming a different
instance and identically to `expression=false`, while an unconditioned control
allowed it in the same window. `cloudsql.users.create` authorises against the
*project*; no instance name can satisfy a name condition. Same shape as the
service-account creation finding.

**A custom role can, because it discriminates by permission rather than by
resource.** `cloudsql.users.create` carries no custom-role restriction, so a
role can hold it while holding none of
`cloudsql.instances.{create,delete,update}`. Measured: a principal holding
exactly that custom role created users on the shared instance for ten
consecutive samples.

What that changes, stated precisely so the controls are not miscounted:

- **The instance-delete vector is closed structurally**, not by a preflight. No
  permission to delete it is held, so no plan, no direct API call and no
  approved-looking run can reach it.
- **`database.ts`'s two deletion-protection flags become load-bearing against
  this identity as well.** Under `roles/cloudsql.admin` they were not — that
  role holds `instances.update` and could clear the API-level flag first. The
  custom role holds no `instances.update`, so both flags now bind.
- **The plan guard is still worth having and is no longer the only thing
  standing between an approved run and the shared instance.** It ships anyway
  (`infra/provisioning/scripts/assert-no-provisioning-deletes.py`), because
  this identity retains project-wide service-account, project-IAM,
  workload-identity-pool, Secret Manager and Cloud Run administration, and
  destroying any of those is still an incident.
- **Tenant data is not fully out of reach.** The role deliberately omits
  `databases.delete` and `users.delete`, so it cannot drop a tenant's database
  — the cost is that a first apply which fails partway and needs its DB user
  replaced is a cleanup for the platform owner rather than a retry. Offboarding
  a tenant is a deliberate act, not something onboarding should be able to do
  by accident.

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
a predefined storage role because every predefined one carrying
`buckets.setIamPolicy` also reaches object contents; `storage.buckets.create`
exists only at project scope, so it cannot be narrowed further. The last
binding is for the provisioning stack's own state in the shared bucket — object
access to each tenant's bucket is granted by the provisioning program as it
creates that bucket.

### P6 — the two platform-held tokens

**`GH_PAT_GHOST_PLATFORM_READ`** — classic PAT, `read:packages`, copied into
every generated repo. Not one per tenant: GitHub Packages accepts only classic
PATs and no API mints one, so a per-tenant token is unavoidably a per-tenant
manual step.

**This does not go away when the repo becomes public, and an earlier version of
this runbook said it would.** Measured against `@branchleft/components`, which
is published from a public repo: an unauthenticated `npm install` fails with
`401 Unauthorized ... authentication token not provided`, and a direct
unauthenticated fetch of the tarball returns 401. GitHub's own npm-registry
documentation agrees — *"You need an access token to publish, install, and
delete private, internal, and public packages."* Public visibility changes the
gate story; it does not change this.

**`GH_PAT_TENANT_PROVISIONING`** — the credential the provisioning workflow
writes to generated repositories with. The default `GITHUB_TOKEN` is scoped to
this repository and can neither create a repo in the org nor set another
repo's variables. Scope: `repo` (classic), or a fine-grained token with
Administration + Contents + Secrets + Variables write on the org.

Both repo-level, never org-level — an org secret is invisible to a private repo
on this plan and resolves to an empty string with no error.

```bash
gh secret set GH_PAT_GHOST_PLATFORM_READ --repo branchLeft/ghost-platform --body "<the PAT>"
gh secret set GH_PAT_TENANT_PROVISIONING --repo branchLeft/ghost-platform --body "<the PAT>"
```

**90-day expiry on both — not "no expiration".** Rotation, for the read token,
mints the replacement before revoking the old one and discovers its fan-out set
by reading which repos hold it rather than from a list someone maintains:

```bash
gh secret set GH_PAT_GHOST_PLATFORM_READ --repo branchLeft/ghost-platform --body "<new PAT>"
for REPO in $(gh repo list branchLeft --limit 100 --json name --jq '.[].name'); do
  if gh secret list --repo "branchLeft/$REPO" 2>/dev/null | grep -q GH_PAT_GHOST_PLATFORM_READ; then
    gh secret set GH_PAT_GHOST_PLATFORM_READ --repo "branchLeft/$REPO" --body "<new PAT>"
  fi
done
```

A tenant repo missed by a stale list fails at `npm ci` on its next run, loudly
but well after the rotation looked done. Revoke the old token only once the
loop has run and one tenant repo's CI has passed on the new one.

### P7 — the roles the tenant's first apply needs

P1–P6 create a tenant's *identity*. Running that tenant's first apply is the
other half of what this identity exists for — the posture is that CI updates
and never bootstraps, so a tenant deployer holds `cloudsql.editor` and cannot
create its own database user.

Derived from what a `GhostTenant` instantiation declares, not from role names:

| Resource | Permission | Covered by |
|---|---|---|
| `gcp.serviceaccount.Account` (runtime SA) | `iam.serviceAccounts.create` | P3 |
| `deployer-can-act-as-<tenant>-sa` | `iam.serviceAccounts.setIamPolicy` | P3 |
| `gcp.projects.IAMMember` (conditional `cloudsql.client`) | `resourcemanager.projects.setIamPolicy` | P3 |
| `gcp.sql.Database`, `gcp.sql.User` | `cloudsql.{databases,users}.create` | P4 custom role |
| `gcp.secretmanager.Secret` / `SecretVersion` / `SecretIamMember` ×4 | `secretmanager.secrets.create`, `.versions.add`, `.setIamPolicy` | `roles/secretmanager.admin` |
| `gcp.storage.HmacKey` | `storage.hmacKeys.create` | `roles/storage.hmacKeyAdmin` |
| `gcp.storage.BucketIAMMember` ×2 on the media bucket | `storage.buckets.setIamPolicy` | bucket-scoped grant |
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
`run.services.setIamPolicy`, which developer does not hold.

**This list is derived, not measured.** Confirm it with the first real
provisioning run against a throwaway tenant; a missing role surfaces as a 403
partway through an apply, which on a first apply leaves a half-created tenant.
Add whatever it turns up here rather than granting a wider role to silence the
error.

### P8 — repo variables the provisioning workflow reads

```bash
gh variable set GCP_PROVISIONING_SA_EMAIL --repo branchLeft/ghost-platform \
  --body "ghost-tenant-provisioner@branchleft-prod.iam.gserviceaccount.com"
gh variable set GCP_PROVISIONING_WIF_PROVIDER --repo branchLeft/ghost-platform \
  --body "projects/<project-number>/locations/global/workloadIdentityPools/ghost-platform-gha/providers/tenant-provisioning"

cd infra/platform
gh variable set PLATFORM_DB_INSTANCE_CONNECTION_NAME --repo branchLeft/ghost-platform \
  --body "$(pulumi stack output dbInstanceConnectionName --stack platform)"
gh variable set PLATFORM_TENANT_IMAGE_REPOSITORY_PATH --repo branchLeft/ghost-platform \
  --body "$(pulumi stack output tenantImageRepositoryDockerPath --stack platform)"
gh variable set PLATFORM_MEDIA_BUCKET_URL --repo branchLeft/ghost-platform \
  --body "$(pulumi stack output mediaBucketUrl --stack platform)"
```

These three are what replaced the tenant program's `StackReference`. Written
as variables rather than read live so a provisioning run does not depend on
the platform stack being applied first.

### What this identity ends up holding

Service-account administration, project IAM administration,
workload-identity-pool administration, Secret Manager administration, Cloud Run
administration, HMAC key administration, KMS administration on the stack key,
bucket administration, and tenant-level Cloud SQL. It is project-admin in all
but name, with one deliberate hole: it cannot create, update or delete a Cloud
SQL instance, and it cannot drop a database or a user.

What makes the rest acceptable is not its size but its reachability. Nothing on
a routine code path can assume it: one workflow, dispatch-only, behind a
required reviewer, behind a federation condition pinned to that workflow file.
If any of those four stops being true, this bootstrap needs redoing rather than
patching.
