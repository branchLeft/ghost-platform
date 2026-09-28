# test_pull_encrypt_store.py

## Module overview

Unit tests for pull_encrypt_store.py.

Real `age` (not a fake `Popen`) for every encryption and stanza-counting
claim -- the property under test is exactly whether this pipeline agrees
with what `age` itself does, so a fake encoder would only ever prove
agreement with itself. The transport is a small local fake here (not
`dial_in_transport.LocalProcessTransport`): what this file proves is
`pull_encrypt_and_store`'s own ordering and gating, independent of any one
transport implementation -- `test_backup_worker.py` covers the two wired
together through the real entry point.
