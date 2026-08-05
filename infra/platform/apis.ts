import * as gcp from '@pulumi/gcp';

// Follows the same shape as website/infra/apis.ts: one gcp.projects.Service
// per API this stack's resources need, so a from-scratch project provisions
// in one pass rather than 403ing on the first resource of a type CI has never
// created before (see website/infra/KNOWN_ISSUES.md's "new resource type"
// entries -- the failure mode there is a silent-looking one: the site stays
// up, only the deploy is broken, and nothing alerts).
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
];

export const enabledApis = requiredServices.map(
  (service) =>
    new gcp.projects.Service(`api-${service}`, {
      service,
      disableOnDestroy: false,
    })
);
