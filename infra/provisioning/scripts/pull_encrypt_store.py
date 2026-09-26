#!/usr/bin/env python3
"""The pull-encrypt-store transport, built once and generic over the
producer command, so a future per-tenant analytics export can reuse it
rather than a second implementation being built for it.

`pull_encrypt_and_store` knows nothing about MySQL, tenants or the backup
bucket specifically. It takes a `DialInTransport` (dial_in_transport.py), a
command and env to run over it, one `age` recipient, and a list of
`CopyTarget`s to write the result to -- so a different caller can invoke
this same function with a different command and a different recipient,
never a second pull-encrypt-store implementation. `backup_worker.py` is the
one caller in this change; it supplies the MySQL-specific floor watching
on top.

The caller contract this module exists to hold, from the per-tenant dump
producer's own review round:

  1. Never put an object before the producer exits 0. Achieved
     structurally, not by a check that could be skipped: the producer's
     stdout is streamed straight into `age`'s stdin as it arrives, and the
     ciphertext `age` writes lands in a local temp file this function reads
     back ONLY after both the producer and `age` have exited -- so there is
     no code path that can reach a `copy.put()` call before that. On a
     nonzero producer exit, `age` is still drained and closed (so it never
     hangs on a half-written stdin) but its output is discarded, unread.
  2. Never pass a storage or encryption credential into the producer's
     invocation channel. `assert_no_forbidden_env` runs before anything
     else -- see dial_in_transport.py, which enforces the same property a
     second, independent time inside the transport itself.

Plaintext touches this process only in transit (piped into `age`'s stdin);
the one file this function ever writes to disk holds ciphertext from the
moment `age` opens it. That is the "buffer to a local encrypted temp"
half of the caller contract, chosen over the multipart-upload alternative
because every `copy.put()` here is already a single, complete, in-memory
`bytes` object once encryption finishes -- a multipart upload has nothing
to buy back that a temp file does not already give for free.
"""

from __future__ import annotations

import dataclasses
import subprocess
import tempfile
from collections.abc import Callable, Mapping, Sequence

from dial_in_transport import DialInTransport, DialInTransportError, assert_no_forbidden_env
from media_backup_restore import count_age_recipient_stanzas


class PullEncryptStoreError(Exception):
    """A stage of the pipeline did not complete, or a control this module
    exists to hold did not pass. Distinct from a producer's ordinary
    nonzero exit, which is reported through `PullResult.ok`, not raised --
    a caller runs one tenant at a time and a single tenant's producer
    failure is not this pipeline's own defect."""


@dataclasses.dataclass(frozen=True)
class CopyTarget:
    """One destination `pull_encrypt_and_store` writes the finished
    ciphertext to. `put` is a zero-argument-shaped callable over the
    ciphertext bytes, already bound to whatever bucket/endpoint/credential
    that copy needs -- this module never sees a credential itself, which is
    what makes it generic over both the backup bucket and analytics'
    destination."""

    name: str
    put: Callable[[bytes], None]


@dataclasses.dataclass(frozen=True)
class PullResult:
    ok: bool
    exit_code: int
    stanza_count: int | None
    copies_written: tuple[str, ...]
    error: str | None


class _EncryptingSink:
    """What the transport writes the producer's stdout into. Forwards every
    line to `age`'s stdin (ciphertext only ever lands on disk, never
    plaintext) and, optionally, to a caller-supplied watcher -- e.g.
    `backup_worker.py`'s own floor-table observer, watching the same bytes
    on their way past rather than trusting the producer's exit code alone.
    """

    def __init__(self, *, age_stdin, chunk_watcher: Callable[[bytes], None] | None) -> None:
        self._age_stdin = age_stdin
        self._chunk_watcher = chunk_watcher

    def write(self, chunk: bytes) -> int:
        if self._chunk_watcher is not None:
            self._chunk_watcher(chunk)
        self._age_stdin.write(chunk)
        return len(chunk)


def pull_encrypt_and_store(
    *,
    transport: DialInTransport,
    command: Sequence[str],
    env: Mapping[str, str],
    age_recipient: str,
    copies: Sequence[CopyTarget],
    chunk_watcher: Callable[[bytes], None] | None = None,
    post_stream_check: Callable[[], None] | None = None,
    popen=subprocess.Popen,
    count_stanzas=count_age_recipient_stanzas,
) -> PullResult:
    """Dials in, runs `command`, encrypts what it wrote to exactly one
    recipient, and stores the result to every `copies` entry -- never
    before the producer's exit is confirmed 0, never to a second recipient,
    and never before `post_stream_check` (if given) has passed.

    `post_stream_check` runs after a 0 exit and a confirmed one-recipient
    ciphertext, but BEFORE any `copy.put()` -- it is the hook a caller like
    `backup_worker.py` uses to gate storage on its own independent evidence
    (its floor-table watch), rather than only reporting that evidence after
    the fact once the copies are already written. Raising from it aborts
    with no copy ever called.

    Raises `PullEncryptStoreError` for a defect in this pipeline itself
    (the forbidden-env check, a stanza count other than 1, `age` failing on
    a successful dump, `post_stream_check` raising, or a copy's `put`
    raising). Returns a `PullResult` with `ok=False` for the producer's own
    ordinary nonzero exit -- that is an expected outcome for one tenant,
    not this pipeline's failure.
    """
    try:
        assert_no_forbidden_env(env)
    except DialInTransportError as exc:
        # Re-raised as this module's own exception type -- a caller of
        # `pull_encrypt_and_store` catches one exception type for every
        # defect in this pipeline, transport-level or not.
        raise PullEncryptStoreError(str(exc)) from exc
    if not copies:
        raise PullEncryptStoreError(
            "no copies configured -- refusing to run a producer for nowhere to store its output"
        )

    with tempfile.TemporaryFile(prefix="pull-encrypt-store-", suffix=".age") as ciphertext_file:
        age_process = popen(
            ["age", "-r", age_recipient],
            stdin=subprocess.PIPE,
            stdout=ciphertext_file,
            stderr=subprocess.PIPE,
        )
        sink = _EncryptingSink(age_stdin=age_process.stdin, chunk_watcher=chunk_watcher)

        try:
            exit_code = transport.run(command=command, env=env, stdout=sink)
        finally:
            # age is always drained and waited on, whatever the producer
            # did -- a nonzero producer exit must not leave age hanging on
            # a stdin nobody closes.
            age_process.stdin.close()
            age_returncode = age_process.wait()
            age_stderr = age_process.stderr.read()
            age_process.stderr.close()

        if exit_code != 0:
            return PullResult(
                ok=False,
                exit_code=exit_code,
                stanza_count=None,
                copies_written=(),
                error=(
                    f"producer exited {exit_code} -- discarding whatever streamed; no object is "
                    "ever put before a 0 exit"
                ),
            )

        if age_returncode != 0:
            raise PullEncryptStoreError(
                f"age exited {age_returncode} while encrypting a successful dump: "
                f"{age_stderr.decode(errors='replace')}"
            )

        ciphertext_file.seek(0)
        ciphertext = ciphertext_file.read()

    stanzas = count_stanzas(ciphertext)
    if stanzas != 1:
        raise PullEncryptStoreError(
            f"encrypted output carries {stanzas} age recipient stanza(s), expected exactly 1 -- "
            "refusing to store it. A second recipient here is the exact defect "
            "09-backup-and-recovery.html names: it would leave this tenant's backup readable "
            "after their key is destroyed, with every other signal still green."
        )

    if post_stream_check is not None:
        post_stream_check()

    written: list[str] = []
    for copy in copies:
        try:
            copy.put(ciphertext)
        except Exception as exc:  # noqa: BLE001 -- surfaced with which copies already landed
            raise PullEncryptStoreError(
                f"copy {copy.name!r} failed after {written!r} already succeeded: {exc}"
            ) from exc
        written.append(copy.name)

    return PullResult(ok=True, exit_code=0, stanza_count=stanzas, copies_written=tuple(written), error=None)
