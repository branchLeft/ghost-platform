import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { projectId } from './config';
import { enabledApis } from './apis';
import { mediaBucket } from './mediaBucket';

/**
 * The identity GitHub Actions assumes, via Workload Identity Federation
 * (`workloadIdentity.ts`), to apply this stack.
 *
 * Separate from website/infra's `github-actions-deployer` on purpose. That SA
 * carries roles for Cloud Run, load balancing, Certificate Manager and
 * Secret Manager, none of which this stack has any use for; and it is
 * federated to `branchLeft/website`, so reusing it would mean two repos'
 * workflows sharing one blast radius. One deploy identity per repo, each
 * scoped to what its own program actually creates.
 */
export const deployerSa = new gcp.serviceaccount.Account(
  'ghost-platform-deployer-sa',
  {
    // 6-30 chars; `ghost-platform-deployer` is 23. Resulting email is
    // ghost-platform-deployer@<project>.iam.gserviceaccount.com -- the
    // address RUNBOOK-bootstrap.md's gcloud grants use verbatim.
    accountId: 'ghost-platform-deployer',
    displayName: 'Ghost platform - GitHub Actions CI/CD identity',
  },
  { dependsOn: enabledApis }
);

export const deployerMember = pulumi.interpolate`serviceAccount:${deployerSa.email}`;

/**
 * Project-level roles, derived from what this program's four resource files
 * actually create -- not copied from website/infra, whose list is mostly
 * Cloud Run and edge roles this stack has no resources for.
 *
 * Every role below was checked against the live IAM API with
 * `gcloud iam roles describe <role> --format="value(includedPermissions)"`,
 * on 2026-08-05, rather than inferred from the role's name. The permission
 * claims in the comments are quoting that output.
 *
 * **The governing assumption: CI updates, it does not bootstrap.** The platform owner's
 * one-time local `pulumi up` (RUNBOOK-bootstrap.md) creates every resource
 * here under their own credentials. From then on CI only ever reads and
 * updates them. That lets several of these roles be strictly weaker than the
 * "admin" role the resource type suggests -- see `cloudsql.editor` below,
 * which cannot create *or delete* a Cloud SQL instance at all.
 *
 * **These bindings are platform-owner-only to create or change.** The deployer SA has
 * no `resourcemanager.projects.setIamPolicy`, so it cannot grant itself
 * anything; a CI `pulumi up` that encounters a *new* project-level
 * `IAMMember` here 403s, and because a failed resource aborts the whole
 * update, that also blocks every unrelated change in the same run. That is
 * the failure mode website/infra/KNOWN_ISSUES.md documents twice
 * ("...needs manual serviceusage.serviceUsageAdmin", "A missing project role
 * fails the deploy silently from the app's point of view"). Adding a role to
 * this list therefore means: `gcloud projects add-iam-policy-binding` first,
 * `pulumi import` second, merge third -- never "let CI apply it".
 */
const projectRoles: Array<[string, string]> = [
  // database.ts -- gcp.sql.DatabaseInstance.
  //
  // `roles/cloudsql.editor`, deliberately NOT `roles/cloudsql.admin`.
  // Verified difference: editor holds cloudsql.instances.{get,list,update}
  // and the listServerCas/listServerCertificates reads the provider needs to
  // populate the instance's outputs, but holds neither
  // `cloudsql.instances.create` nor `cloudsql.instances.delete` -- both are
  // present only in admin. Since the instance is created by the platform owner's bootstrap
  // apply, CI never needs create, and *cannot* delete the one instance every
  // tenant's data lives on even if a future diff asks it to. That is a
  // stronger guarantee than the two deletion-protection flags in
  // database.ts, because it holds against any call this identity can make,
  // not just the ones Pulumi makes.
  //
  // Known consequence, stated rather than discovered later: a change that
  // *replaces* the instance (an immutable field like `region`) will 403 in
  // CI. That is intended -- replacing the shared instance is a platform-owner-gated
  // migration, not a merge.
  ['deployer-cloudsql-editor', 'roles/cloudsql.editor'],

  // registry.ts -- gcp.artifactregistry.Repository.
  //
  // `artifactregistry.repositories.update` is the permission CI needs to
  // apply a change to the repository (description, labels, a future cleanup
  // policy). Verified: it appears in `roles/artifactregistry.admin` and in
  // no weaker predefined role -- repoAdmin and writer both grant only
  // get/list plus artifact-level upload/delete, not repository update. So
  // admin is the minimum predefined role that can do the job, and it carries
  // `repositories.delete` as an unavoidable side effect. Compensating
  // control: scripts/assert-no-platform-deletes.py runs against the real
  // preview immediately before `pulumi up` in CI.
  ['deployer-artifact-registry-admin', 'roles/artifactregistry.admin'],

  // NOTE: mediaBucket.ts's grant is deliberately NOT in this list. It is
  // bucket-scoped instead -- see `deployerMediaBucketAccess` below for why
  // a project-level storage role was the wrong answer.

  // apis.ts -- gcp.projects.Service x6.
  //
  // The only predefined role that can enable a service, so there is no
  // narrower choice to make. It is worth being accurate about what that
  // costs, because the role's name undersells it: alongside
  // `serviceusage.services.{enable,disable,get,list,use}`, the live
  // permission list also includes `serviceusage.quotas.update`,
  // `cloudquotas.quotas.update`, `serviceusage.consumerpolicy.update`,
  // `serviceusage.contentsecuritypolicy.update` and
  // `serviceusage.mcppolicy.update` -- i.e. this identity can also change
  // project quotas and consumer policies, not just turn APIs on. Accepted
  // (no alternative exists), disclosed rather than implied away.
  //
  // Same role, for the same reason, that website/infra had to add by hand
  // the first time CI touched a new entry in its own `requiredServices`
  // (KNOWN_ISSUES.md). Note it does NOT carry `resourcemanager.projects.get`
  // -- that comes from the two roles above, both of which include it.
  ['deployer-service-usage-admin', 'roles/serviceusage.serviceUsageAdmin'],
];

for (const [name, role] of projectRoles) {
  new gcp.projects.IAMMember(name, {
    project: projectId,
    role,
    member: deployerMember,
  });
}

/**
 * Media bucket access -- **bucket-scoped, not project-scoped**, and the
 * reasoning matters more than the one-line change.
 *
 * The first version of this file granted `roles/storage.admin` on the
 * *project*, on the argument that it is the only GA non-legacy predefined
 * role holding both `storage.buckets.update` and
 * `storage.buckets.setIamPolicy`, which the media bucket and its allUsers
 * reader binding need. That reasoning was right about the role and wrong
 * about the scope, and the gap it left is not theoretical:
 *
 * `gs://branchleft-pulumi-state` is the only bucket in `branchleft-prod`
 * (verified: `gcloud storage ls --project=branchleft-prod` returns exactly
 * one bucket), and it holds the Pulumi state for four stacks --
 * `branchleft-ghost-platform`, `branchleft-shared-infra`,
 * `branchleft-website-infra` and `ghost-platform-tenant-smoke-test`
 * (verified: `gcloud storage ls gs://branchleft-pulumi-state/.pulumi/stacks/`).
 * A project-level storage role therefore hands this repo's CI the ability to
 * delete or corrupt the *website* and *shared-infra* stacks' state files. A
 * compromised workflow run here would take out the marketing site's and the
 * shared edge's ability to deploy, from a repo that owns neither. That is a
 * strictly wider grant than the precedent it claimed to follow:
 * website/infra's own deployer only ever received a *bucket-scoped*
 * `roles/storage.objectAdmin` on this bucket (KNOWN_ISSUES.md).
 *
 * So the grant moves to the one bucket this stack actually owns. Two
 * consequences, both deliberate:
 *
 * 1. **CI can no longer reach the Pulumi state bucket via this role**, which
 *    makes RUNBOOK-bootstrap.md's explicit `gcloud storage buckets
 *    add-iam-policy-binding` on `gs://branchleft-pulumi-state` genuinely
 *    load-bearing and genuinely irreducible -- exactly the chicken-and-egg
 *    KNOWN_ISSUES.md describes, rather than the redundant belt-and-braces
 *    step the earlier version of that runbook (honestly, but wrongly)
 *    described it as.
 * 2. **CI can no longer create a bucket at all.** `storage.buckets.create`
 *    only exists at project scope. The platform owner's bootstrap apply creates the media
 *    bucket under their own credentials; CI only ever updates it. Same shape
 *    as `roles/cloudsql.editor` above, and the same tradeoff -- a change
 *    that *replaces* the bucket 403s in CI, which is the correct outcome for
 *    a resource holding every tenant's media.
 *
 * **Why `roles/storage.legacyBucketOwner` and not bucket-scoped
 * `roles/storage.admin`.** An earlier revision rejected legacyBucketOwner,
 * on the grounds that it grants `storage.objects.{create,delete,list}` --
 * true, but that objection was about granting it at *project* level, where
 * those object permissions spread across every bucket including the state
 * bucket. At bucket scope the objection largely evaporates, and what is left
 * is a real gain: verified against the live role definition,
 * legacyBucketOwner holds `storage.buckets.{get,getIamPolicy,setIamPolicy,
 * update}` -- everything this program needs -- and **not
 * `storage.buckets.delete`**, which bucket-scoped `storage.admin` would
 * carry. The media bucket is the one resource in this stack with no
 * deletion-protection field of any kind (it is the reason
 * scripts/assert-no-platform-deletes.py exists), so removing the delete
 * permission outright is the single most valuable narrowing available here.
 * It is also this role's intended scope: "Legacy Bucket Owner" is the
 * bucket-level ACL-equivalent role, so using it at bucket level is idiomatic
 * rather than the misuse the earlier comment implied.
 *
 * **Disclosed residual, not closed.** legacyBucketOwner still lets CI
 * create, delete and list *objects* in this bucket -- i.e. a compromised
 * workflow run could delete every tenant's media file by file. No predefined
 * role separates "manage bucket configuration" from "manage bucket
 * contents" at bucket scope (checked against the full `roles/storage.*`
 * list: admin and legacyBucketOwner both carry object permissions;
 * everything narrower loses `setIamPolicy`). Closing this needs a custom
 * role, which is itself a project-level IAM resource and so platform-owner-gated;
 * deliberately not taken on in this change. Object versioning plus the
 * 30-day noncurrent lifecycle rule in mediaBucket.ts is the partial
 * mitigation that already exists.
 *
 * **Self-referential, and that is fine.** This binding grants the permission
 * (`storage.buckets.setIamPolicy`) needed to manage this binding. It is
 * created once by the platform owner's bootstrap and then never changes, so CI never
 * exercises the circularity. If it is ever edited, CI can apply the edit --
 * bounded, like everything else here, to this one bucket.
 */
export const deployerMediaBucketAccess = new gcp.storage.BucketIAMMember(
  'ghost-platform-media-deployer-manage',
  {
    bucket: mediaBucket.name,
    role: 'roles/storage.legacyBucketOwner',
    member: deployerMember,
  }
);

/**
 * Roles deliberately NOT granted, with the reasoning, so their absence is
 * legible as a decision instead of looking like an omission the next person
 * should "fix":
 *
 * - `roles/iam.workloadIdentityPoolAdmin`. Without it, CI cannot modify the
 *   pool or provider in `workloadIdentity.ts` -- in particular it cannot
 *   widen `attributeCondition`. With it, any workflow run in this repo could
 *   rewrite the condition to admit another repository and hand that repo the
 *   deployer SA. The control this stack's WIF setup exists to provide would
 *   then be modifiable by the thing it is controlling.
 *
 * - `roles/iam.serviceAccountAdmin`. Same shape: CI cannot recreate or
 *   re-permission its own identity.
 *
 * - `roles/resourcemanager.projectIamAdmin` (or anything else carrying
 *   `resourcemanager.projects.setIamPolicy`). CI cannot grant itself roles.
 *   This is the programme-level rule, not a local preference.
 *
 * - Any project-level `roles/storage.*`. See `deployerMediaBucketAccess`
 *   above: the Pulumi state bucket for four stacks, two of them owned by
 *   other repos, lives in this project, so a project-level storage grant
 *   here reaches into `website`'s and `shared-infra`'s state.
 *
 * - `roles/cloudkms.admin`. CI needs to *use* the stack's KMS key to decrypt
 *   `Pulumi.platform.yaml`'s `encryptedkey`, which is
 *   `roles/cloudkms.cryptoKeyEncrypterDecrypter` granted on the key itself
 *   via gcloud (RUNBOOK-bootstrap.md), never a project-level admin role, and
 *   never managed from inside this program -- website/infra/KNOWN_ISSUES.md
 *   records that attempting the latter 403s on
 *   `cloudkms.cryptoKeys.getIamPolicy` and that granting admin to fix it
 *   would let the pipeline rewrite who may decrypt its own secrets.
 *
 * - `roles/cloudsql.admin` and `roles/secretmanager.admin`, which
 *   `provisioningUser.ts`'s two resources would need CI to hold. **This is a
 *   live constraint on that file, not a hypothetical.** Verified against the
 *   live IAM API on 2026-08-05: `roles/cloudsql.editor` above holds
 *   `cloudsql.users.{get,list}` and *not* `cloudsql.users.{create,update,
 *   delete}` -- those three exist only in `roles/cloudsql.admin`, which also
 *   carries `cloudsql.instances.delete`, the single permission this stack's
 *   whole identity design was built to withhold. Trading the instance-delete
 *   guarantee for the ability to create one user is a bad trade. Likewise the
 *   deployer holds no `secretmanager.*` permission at all.
 *
 *   The consequence, per this file's governing "CI updates, it does not
 *   bootstrap" assumption: **`provisioningUser.ts`'s resources must be
 *   created by the platform owner's own local `pulumi up`, not by the merge-to-main CI
 *   apply.** The CI apply will 403 on `cloudsql.users.create` if it gets
 *   there first. Once they exist in state, CI's `pulumi up` -- which runs
 *   without `--refresh` (infra-platform-ci.yml) and so diffs against state
 *   rather than live GCP -- makes no API call against them and needs no new
 *   role. See RUNBOOK-bootstrap.md's "Applying the provisioning credential".
 *
 * The practical upshot: a PR that edits `workloadIdentity.ts` or the
 * `projectRoles` list above cannot be applied by CI. It fails loudly, and
 * the fix is the platform owner applying it locally -- see RUNBOOK-bootstrap.md's
 * "Changing the identity resources later" section.
 */
export const deployerServiceAccountEmail = deployerSa.email;
