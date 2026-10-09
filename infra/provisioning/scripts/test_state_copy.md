# test_state_copy.py

Tests for `state_copy.py` against an in-memory store and the real `age`
binary. Each control has a test that fails when it is removed: the
partial-configuration refusal, manifest-last ordering, the empty and
stackless listing floor, tamper and incomplete-generation refusal on
restore, path-traversal refusal, a failed bucket not advancing its success
gauge, and the configured gauge existing before any success.
