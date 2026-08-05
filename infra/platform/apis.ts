import * as gcp from '@pulumi/gcp';

// Follows the same shape as website/infra/apis.ts: one gcp.projects.Service
// per API this stack's resources need, so a from-scratch project provisions
// in one pass rather than 403ing on the first resource of a type CI has never
// created before (see website/infra/KNOWN_ISSUES.md's "new resource type"
// entries -- the failure mode there is a silent-looking one: the site stays
// up, only the deploy is broken, and nothing alerts).
//
// Several entries here are also declared by website/infra/apis.ts against the
// same project (artifactregistry and cloudresourcemanager already were; iam
// and iamcredentials are added below). Two stacks declaring the same
// `gcp.projects.Service` is benign *here specifically* because enabling an
// already-enabled service is a no-op success and every declaration on both
// sides sets `disableOnDestroy: false`, so neither stack's destroy can turn
// an API off underneath the other. Do not drop that flag from either program
// without revisiting this.
const requiredServices = [
  // Cloud SQL instance (database.ts).
  'sqladmin.googleapis.com',
  // Tenant Ghost image repository (registry.ts).
  'artifactregistry.googleapis.com',
  // Shared media bucket (mediaBucket.ts). Enabled on virtually every GCP
  // project by default already (this project already uses GCS for the
  // Pulumi state bucket), declared explicitly anyway so a from-scratch
  // project doesn't depend on that coincidence.
  'storage.googleapis.com',
  // Needed to read project metadata / manage the gcp.projects.Service
  // resources below -- same rationale as website/infra/apis.ts.
  'cloudresourcemanager.googleapis.com',
  // The Workload Identity pool/provider and the deployer service account
  // (workloadIdentity.ts, serviceAccounts.ts).
  'iam.googleapis.com',
  // `generateAccessToken`, which is what google-github-actions/auth calls
  // after the STS exchange to mint the deployer SA's short-lived token. A
  // distinct API from iam.googleapis.com, and a from-scratch project has
  // neither.
  'iamcredentials.googleapis.com',
  // Deliberately NOT declared: `sts.googleapis.com`. It is the obvious
  // fourth entry for a WIF setup and it is not needed -- verified against
  // this project rather than assumed: `gcloud services list --enabled
  // --project=branchleft-prod --filter="config.name~sts"` returns nothing,
  // while website/infra's identical WIF setup exchanges tokens against this
  // same project on every deploy. Adding it would enable an API on the
  // strength of a guess.
];

export const enabledApis = requiredServices.map(
  (service) =>
    new gcp.projects.Service(`api-${service}`, {
      service,
      disableOnDestroy: false,
    })
);
