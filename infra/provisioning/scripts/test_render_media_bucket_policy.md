# test_render_media_bucket_policy.py

## Unenumerated bucket action test

The accepted cost of removing `NotAction`, asserted rather than left in a
docstring where nothing checks it. `NotAction` bought exactly this property
and did not deliver it. An enumerated denylist IS enforced and does let an
unlisted action through, so the mitigation is the breadth of
BUCKET_CONFIGURATION_ACTIONS — pinned member by member in
test_bucketpolicy.py — not the shape of the statement.

This test characterises a known loss. If it starts failing, the catch-all
has been restored for the tenant somehow: delete THIS test, and do not
touch the policy. That instruction applies to this test only — see the
sibling below, which asserts the opposite and must never be deleted.
