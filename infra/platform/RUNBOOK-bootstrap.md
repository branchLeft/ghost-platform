# Bootstrap runbook — `platform` stack, one time only

This stack has never been applied. Everything in it is a `create`.

Almost all of it is CI's job from now on, but CI cannot create the identity
it would need in order to run — so exactly one apply has to happen from a
workstation, under the platform owner's own credentials, and three grants
have to be made
by hand after it. That is what this runbook is. **It is run once.** After the
last step, every push to `main` applies this stack automatically and no local
`pulumi up` is ever needed again.

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
gcloud config get-value account
```

That has to match the account holding `roles/owner` on the project — not just
"whoever is running this", which every operator trivially satisfies for
themselves. Cross-check against the authoritative source rather than a name
in this file:

```bash
gcloud projects get-iam-policy branchleft-prod \
  --flatten="bindings[].members" \
  --filter="bindings.role:roles/owner" \
  --format="value(bindings.members)"
```

If the two commands don't name the same account, stop — this step grants IAM
that only an owner-level identity can grant, and will fail partway through
(or silently grant less than intended) under any other account.

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

```
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
