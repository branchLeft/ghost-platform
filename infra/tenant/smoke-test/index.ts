import { GhostTenant } from '../index';

// Deliberately fake -- not a real Cloud SQL instance connection name, not a
// real bucket, not a real image tag. Proves GhostTenant's own resource plan
// (naming, IAM wiring, env vars) without ever depending on the real
// `platform` stack existing or being reachable. See ../README (smoke-test
// README.md) for why this is safe to `pulumi preview` but must never be
// `pulumi up`'d.
new GhostTenant('smoke-test-tenant', {
  tenantName: 'smoke-test',
  siteUrl: 'https://smoke-test.example.org',
  imageDigestOrTag: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  platform: {
    dbInstanceConnectionName: 'branchleft-prod-fake:europe-west1:ghost-platform-db-fake',
    tenantImageRepositoryDockerPath:
      'europe-west1-docker.pkg.dev/branchleft-prod-fake/ghost-platform-tenant-fake',
    mediaBucketUrl: 'gs://branchleft-prod-fake-ghost-platform-media-fake',
  },
});
