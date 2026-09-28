# test_configure_backup_bucket.py

## Module overview

Unit tests for `configure_backup_bucket.py`.

No real network call: `put` is always a fake. What matters here is the
sequencing (the fence goes on last, after the two configuration calls it
denies to everyone but the operator) and that a failed call never reaches
the next one.

The heaviest weight is on the refusals around the policy. Applying a bucket
policy is the one operation in this file that can be irreversible: a policy
that denies the caller `PutBucketPolicy` cannot be edited or removed by any
key in the project afterwards. Every one of those refusals has to be
asserted here, because none of them is visible from a `put-bucket-policy`
that succeeds.

## fence_policy

The shape `render-bucket-fence-policy.py` emits, trimmed to what is checked
here: one Allow granting the named workload key object access (mirroring
the generator's `AllowNamedKeysObjectAccess` -- present so the checks below
can tell a legitimately-exempted principal from one that isn't), one
bucket-configuration deny exempting the operator, and one object deny
exempting both named keys.

A hand-written fixture is a SECOND COPY of the generator's shape, and it
drifted: it carried `NotAction` after the generator stopped emitting it, so
the lockout-refusal checks below -- the ones guarding a live apply -- were
reasoning about a document that can no longer exist. It is enumerated now
for the same reason the generator is: this engine stores `NotAction` and
enforces nothing, so a fixture built on it models an inert statement as a
working one. `test_the_fixture_has_not_drifted_back` below is what keeps
the two from separating again.
