# test_configure_state_bucket.py

Tests `configure_state_bucket.py` against a fake provider: create and read
back, idempotent re-run, accepted-but-ignored versioning and lifecycle caught
by the read-back, configurable expiry, and the missing-key refusal.
