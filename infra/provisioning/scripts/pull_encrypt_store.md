# pull_encrypt_store.py

## Module overview

The pull-encrypt-store transport, built once and generic over the producer
command, so a future per-tenant analytics export can reuse it rather than a
second implementation being built for it.

`pull_encrypt_and_store` knows nothing about MySQL, tenants or the backup
bucket specifically. It takes a `DialInTransport` (dial_in_transport.py), a
command and env to run over it, one `age` recipient, and a list of
`CopyTarget`s to write the result to -- so a different caller can invoke
this same function with a different command and a different recipient,
never a second pull-encrypt-store implementation. `backup_worker.py` is the
one caller in this change; it supplies the MySQL-specific floor watching on
top.

The caller contract this module exists to hold, from the per-tenant dump
producer's own review round:

1. Never put an object before the producer exits 0. Achieved structurally,
   not by a check that could be skipped: the producer's stdout is streamed
   straight into `age`'s stdin as it arrives, and the ciphertext `age`
   writes lands in a local temp file this function reads back ONLY after
   both the producer and `age` have exited -- so there is no code path
   that can reach a `copy.put()` call before that. On a nonzero producer
   exit, `age` is still drained and closed (so it never hangs on a
   half-written stdin) but its output is discarded, unread.
2. Never pass a storage or encryption credential into the producer's
   invocation channel. `assert_no_forbidden_env` runs before anything else
   here, and `dial_in_transport.LocalProcessTransport` calls that same
   function again at its own boundary -- one shared implementation, called
   from two sites, so a caller reaching either module gets the refusal at
   the earliest point it invokes. That is not defense in depth against a
   defect inside `assert_no_forbidden_env` itself; both sites would miss
   the same case together.

Plaintext touches this process only in transit (piped into `age`'s stdin);
the one file this function ever writes to disk holds ciphertext from the
moment `age` opens it. That is the "buffer to a local encrypted temp" half
of the caller contract, chosen over the multipart-upload alternative
because every `copy.put()` here is already a single, complete, in-memory
`bytes` object once encryption finishes -- a multipart upload has nothing
to buy back that a temp file does not already give for free.

## pull_encrypt_and_store

Dials in, runs `command`, encrypts what it wrote to exactly one recipient,
and stores the result to every `copies` entry -- never before the
producer's exit is confirmed 0, never to a second recipient, and never
before `post_stream_check` (if given) has passed.

`post_stream_check` runs after a 0 exit and a confirmed one-recipient
ciphertext, but BEFORE any `copy.put()` -- it is the hook a caller like
`backup_worker.py` uses to gate storage on its own independent evidence
(its floor-table watch), rather than only reporting that evidence after the
fact once the copies are already written. Raising from it aborts with no
copy ever called.

Raises `PullEncryptStoreError` for a defect in this pipeline itself (the
forbidden-env check, a stanza count other than 1, `age` failing on a
successful dump, `post_stream_check` raising, or a copy's `put` raising).
Returns a `PullResult` with `ok=False` for the producer's own ordinary
nonzero exit -- that is an expected outcome for one tenant, not this
pipeline's failure.
