import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { projectId } from './config';
import { enabledApis } from './apis';

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
 * **The governing assumption: CI updates, it does not bootstrap.** Rob's
 * one-time local `pulumi up` (RUNBOOK-bootstrap.md) creates every resource
 * here under his own credentials. From then on CI only ever reads and
 * updates them. That lets several of these roles be strictly weaker than the
 * "admin" role the resource type suggests -- see `cloudsql.editor` below,
 * which cannot create *or delete* a Cloud SQL instance at all.
 *
 * **These bindings are Rob-only to create or change.** The deployer SA has
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
  // present only in admin. Since the instance is created by Rob's bootstrap
  // apply, CI never needs create, and *cannot* delete the one instance every
  // tenant's data lives on even if a future diff asks it to. That is a
  // stronger guarantee than the two deletion-protection flags in
  // database.ts, because it holds against any call this identity can make,
  // not just the ones Pulumi makes.
  //
  // Known consequence, stated rather than discovered later: a change that
  // *replaces* the instance (an immutable field like `region`) will 403 in
  // CI. That is intended -- replacing the shared instance is a Rob-gated
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

  // mediaBucket.ts -- gcp.storage.Bucket and gcp.storage.BucketIAMMember.
  //
  // Needs `storage.buckets.update` (versioning, lifecycle rules) and
  // `storage.buckets.setIamPolicy` (the allUsers reader binding). Verified:
  // the only GA, non-legacy predefined role containing both is
  // `roles/storage.admin`.
  //
  // `roles/storage.legacyBucketOwner` was evaluated as a narrower
  // alternative and rejected. It genuinely is narrower on the axis that
  // matters most -- it has buckets.{get,update,getIamPolicy,setIamPolicy}
  // but neither buckets.create nor buckets.delete, so CI could not delete
  // the media bucket -- but it still grants storage.objects.{create,delete,
  // list} across every bucket in the project, so CI could still delete every
  // tenant's media object by object. The safety gain is partial while the
  // cost is real: it is an ACL-compatibility role, and reaching for one as
  // the primary grant in a new system reads as a mistake to the next person.
  // Taking storage.admin plus the preview delete-guard instead, and writing
  // the rejected option down so it is a decision rather than an oversight.
  //
  // Second-order consequence, deliberately made explicit: project-level
  // storage.admin also covers `gs://branchleft-pulumi-state`, so the
  // deployer SA can read and write this stack's own Pulumi state through
  // this binding. RUNBOOK-bootstrap.md still grants state-bucket access
  // separately and explains why relying on this implication is a bad idea.
  ['deployer-storage-admin', 'roles/storage.admin'],

  // apis.ts -- gcp.projects.Service x6.
  //
  // Verified to hold serviceusage.services.{enable,disable,get,list,use}.
  // The same role, for the same reason, that website/infra had to add by
  // hand the first time CI touched a new entry in its own `requiredServices`
  // (KNOWN_ISSUES.md). Note it does NOT carry `resourcemanager.projects.get`
  // -- that comes from the three roles above, all of which include it.
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
 * - `roles/cloudkms.admin`. CI needs to *use* the stack's KMS key to decrypt
 *   `Pulumi.platform.yaml`'s `encryptedkey`, which is
 *   `roles/cloudkms.cryptoKeyEncrypterDecrypter` granted on the key itself
 *   via gcloud (RUNBOOK-bootstrap.md), never a project-level admin role, and
 *   never managed from inside this program -- website/infra/KNOWN_ISSUES.md
 *   records that attempting the latter 403s on
 *   `cloudkms.cryptoKeys.getIamPolicy` and that granting admin to fix it
 *   would let the pipeline rewrite who may decrypt its own secrets.
 *
 * The practical upshot: a PR that edits `workloadIdentity.ts` or the
 * `projectRoles` list above cannot be applied by CI. It fails loudly, and
 * the fix is Rob applying it locally -- see RUNBOOK-bootstrap.md's
 * "Changing the identity resources later" section.
 */
export const deployerServiceAccountEmail = deployerSa.email;
