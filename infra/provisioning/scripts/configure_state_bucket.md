# configure_state_bucket.py

Creates one Pulumi state bucket, enables versioning, sets a noncurrent-version
expiry (`--noncurrent-days`, default 46: the estate's erasure window; a
current version never expires, so this is the whole figure), then
reads both settings back and fails unless the provider reports them: an
engine can accept a setting and store nothing. Safe to re-run; an existing
bucket owned by the caller is accepted. The key is the project's `bucket-admin`
key, from `BUCKET_ADMIN_ACCESS_KEY_ID` and `BUCKET_ADMIN_SECRET_ACCESS_KEY`.
The fence policy that admits the state key and the read-only copy key is
applied afterwards with `render-bucket-fence-policy.py`; it is deliberately
not part of this script. Each of those keys is in a project of its own, so
that renderer takes one project id per key (`--admin-project-id`,
`--workload-project-id`, `--reader-project-id`).
