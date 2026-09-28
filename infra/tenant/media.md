# media.ts

## Where one tenant's media lives, derived rather than configured

Each tenant gets its own Object Storage bucket, reached with a credential
allowlisted to that bucket alone. Both names are functions of the slug, so a
tenant stack has no configurable value that could name another tenant's
bucket — the closest thing this platform has to the IAM-condition prefix
isolation the GCP shape used, expressed as an absence of choice rather than
as a policy the stack has to get right.

The same derivation is written a second time, in Python, in
`infra/provisioning/scripts/render-media-bucket-policy.py`: that script runs
before this component ever sees the tenant, because the bucket has to exist
first. The two are kept in step by tests on both sides asserting the same
literal strings, the way `naming.ts` and `db/provision/naming.py` already are.
