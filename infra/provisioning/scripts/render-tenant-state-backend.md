# render-tenant-state-backend.py

## Module overview

Builds the new tenant's Pulumi state backend URL for `provision-tenant.yml` and
refuses anything that is not the storage gateway's shape. The URL is
`s3://<bucket>/<tenant prefix>?endpoint=https://state.branchleft.co.uk&s3ForcePathStyle=true&region=<region>`.

- The bucket (`STATE_GATEWAY_BUCKET`) and the region (`STATE_GATEWAY_REGION`)
  are repository variables. No bucket name is written in this repository.
- The prefix is the `state_prefix` dispatch input: a random identifier from the
  tenant register, lower-case, 24 to 64 characters, one path segment. A prefix
  that is, or contains, the tenant's slug or repository name is refused: it was
  not drawn at random.
- The estate's own state bucket is refused by name.
- The endpoint is a constant of the script and is never read from the
  environment, so no input can point the backend at the object store directly.

On success nothing is printed and `TENANT_BACKEND_URL` and `AWS_REGION` are
appended to `$GITHUB_ENV`. On failure the error names the fields, never their
values. Tests: `test_tenant_state_credential_steps.py`.
