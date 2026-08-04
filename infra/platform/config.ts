import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config('gcp');

export const projectId = gcpConfig.require('project');

// europe-west1 is a hard requirement, not a default -- doc 02's UK/EU data
// residency decision, inherited from website/infra and reaffirmed platform-wide
// in OPEN-QUESTIONS.md #13.
export const region = config.get('region') ?? 'europe-west1';

// Fixed platform-level identifiers. Not stack config, because there is
// exactly one of each of these per platform (not per environment) -- this
// program only ever has one stack ("platform"), unlike website/infra's
// per-environment imageTag pattern.
export const dbInstanceName = 'ghost-platform-db';
export const tenantImageRepositoryId = 'ghost-platform-tenant';
export const mediaBucketName = `${projectId}-ghost-platform-media`;
