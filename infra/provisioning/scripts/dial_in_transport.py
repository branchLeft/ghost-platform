#!/usr/bin/env python3
"""The one channel an org/control-side worker dials a tenant host over.

09-backup-and-recovery.html is explicit that the direction is fixed: the
tenant host "never initiates outward" and the worker "dials in over the
collector's channel -- one transport [reused]". The channel already has one
concrete shape today -- `services/mailgun-shim`'s bearer-token-authenticated
`GET /drain`, dialled by the mail collector -- but that collector's own
production implementation is still being built elsewhere in this estate,
and this repository has no equivalent dial-in server standing in front of
`db/provision/dump_tenant.py` yet either. Guessing either shape here would
be exactly the mistake this file exists to avoid, so this module holds
only:

  - `DialInTransport`, the interface a caller like `pull_encrypt_store.py`
    depends on, so it never has to know which concrete channel it is
    running over;
  - `LocalProcessTransport`, a local test double that runs a producer as an
    ordinary local subprocess. It stands in for a real dial-in call so the
    pipeline's floor-check, single-recipient and never-put-before-exit-0
    properties can be proven against a real local database and a real
    producer without any remote channel existing yet;
  - `UnwiredCollectorChannelTransport`, the loud placeholder a real caller
    gets until the actual channel lands.

OPEN ITEM, flagged rather than guessed at: the real transport -- the one
`services/mailgun-shim`'s `GET /drain` calls "the collector's channel" --
does not exist in this repository yet. It is being built elsewhere, in a
sibling stream of work, and the collector's own shape is that stream's to
decide, not this module's to invent. Wiring a real `DialInTransport`
implementation on top of whatever that stream lands is a follow-up, not
part of this change.
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Mapping, Sequence
from typing import BinaryIO, Protocol

# Every prefix that names a storage or encryption credential in this
# estate's convention (db/provision/dump_tenant.py's own
# FORBIDDEN_ENV_PREFIXES, restated here rather than imported: this module
# runs on the org/control side of the trust boundary the producer's own
# check exists to enforce, and the two sides proving the same property
# independently is the point, not a maintenance burden -- a caller-side
# check that quietly drifted from the producer's would be exactly the kind
# of gap this pipeline exists to close). AWS_* / DB_BACKUP_* for the
# storage credential and endpoint, AGE_* for the encryption recipient: the
# worker holds all three, and none of them may ever reach the environment a
# producer command is invoked with.
FORBIDDEN_ENV_PREFIXES = ("AWS_", "DB_BACKUP_", "AGE_")

# What a local subprocess is allowed to see beyond the caller's own,
# explicit env dict -- PATH only, so a binary can be resolved by name.
# Never a forward of this process's own os.environ: the worker legitimately
# holds AWS_*/AGE_* itself (for the storage and encryption calls
# `pull_encrypt_store.py` makes), and an allowlist is the only shape that
# cannot leak them into a producer invocation by accident.
_CHILD_ENV_ALLOWLIST = ("PATH",)


class DialInTransportError(Exception):
    """The transport itself could not run the producer at all -- distinct
    from the producer's own nonzero exit, which is an ordinary, expected
    outcome this pipeline handles by discarding whatever streamed."""


def assert_no_forbidden_env(env: Mapping[str, str]) -> None:
    """Refuses an env dict carrying a storage or encryption credential
    prefix, before it ever reaches a transport. `pull_encrypt_store.py`
    calls this too -- two independent call sites checking the same
    property, on purpose."""
    present = sorted(name for name in env if name.startswith(FORBIDDEN_ENV_PREFIXES))
    if present:
        raise DialInTransportError(
            "refusing to dial in: the environment a producer would be invoked with carries "
            f"{', '.join(present)} -- the per-tenant dump producer's own caller contract is "
            "that this invocation channel must never carry a storage or encryption "
            "credential, regardless of whether the producer at the other end would refuse "
            "to start with one present"
        )


class DialInTransport(Protocol):
    """One call: run `command` with exactly `env` (nothing else, nothing
    ambient), stream its stdout to `stdout` as it arrives, and return the
    exit code once the process ends. A caller decides what to do with a
    nonzero exit; this interface only ever reports it faithfully."""

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int: ...


class LocalProcessTransport:
    """Runs the producer as an ordinary local subprocess.

    This is a TEST DOUBLE, not the production channel -- see this module's
    docstring. It exists so the pipeline's controls can be proven end to
    end today, against a real producer talking to a real local database,
    without depending on a remote dial-in channel that does not exist in
    this repository yet.

    Streams line-by-line, mirroring `db/provision/dump_tenant.py`'s own
    `run_mysqldump`: a caller watching for a floor-table `INSERT` pattern
    needs whole lines, and a chunk boundary that split one across two
    `stdout.write()` calls would make that watch unreliable for no reason a
    real remote channel would ever force on it.
    """

    def __init__(self, *, popen=subprocess.Popen) -> None:
        self._popen = popen

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int:
        assert_no_forbidden_env(env)
        child_env = {name: os.environ[name] for name in _CHILD_ENV_ALLOWLIST if name in os.environ}
        child_env.update(env)

        process = self._popen(list(command), env=child_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for line in process.stdout:
                stdout.write(line)
        finally:
            process.stdout.close()
        process.stderr.close()
        return process.wait()


class UnwiredCollectorChannelTransport:
    """The transport a real caller gets until the mail collector's channel
    lands and someone wires this backup worker onto it. Raises loudly
    rather than silently falling back to `LocalProcessTransport`, which
    would make a production deploy quietly run the test double."""

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int:
        raise NotImplementedError(
            "no production DialInTransport is wired yet. This pipeline is built behind this "
            "interface deliberately, because the real channel -- the one services/mailgun-shim's "
            "GET /drain calls \"the collector's channel\" -- is still being built elsewhere, in a "
            "sibling stream of work, and its shape is that stream's to decide. Wiring a real "
            "DialInTransport on top of it is a follow-up. For local proof, pass a "
            "LocalProcessTransport instead."
        )
