# test_render_bucket_fence_policy.py

## Module overview

The first failure is a fence that does not fence: every pipeline keeps working,
nothing looks wrong, and every other credential in the project still reaches
the estate's backups. That failure mode is invisible from the outside.

The second is a fence that locks the bucket. It is rarer and far worse: the
statement that would have to be edited is the statement doing the denying, no
other key in the project is exempt, and `DeleteBucket` is denied too. There is
no undo inside the account. Both directions have to be asserted here, because
neither is observable from a successful `put-bucket-policy`.
