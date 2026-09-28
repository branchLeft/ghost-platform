#!/usr/bin/env python3
"""The one channel an org/control-side worker dials a tenant host over: the
tenant host never initiates outward, the worker dials in over the
collector's channel. The real transport does not exist in this repository
yet — being built elsewhere — so this module holds only the interface, a
local test double, and a loud placeholder for a real caller.
See dial_in_transport.md#module-overview.
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Mapping, Sequence
from typing import BinaryIO, Protocol

# Every prefix that names a storage or encryption credential in this
# estate's convention, restated here rather than imported since the two
# sides proving the same property independently is the point, not a
# maintenance burden. See dial_in_transport.md#forbidden_env_prefixes.
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
    calls this exact function too, at its own boundary -- two call sites
    sharing one implementation, not two independent ones: a bug in this
    function would defeat the check at both sites at once. The two-call-site
    shape still matters -- a caller of either module gets the refusal at
    the earliest point it invokes -- but it is not defense in depth against
    a defect in this function itself."""
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
    """Runs the producer as an ordinary local subprocess. A TEST DOUBLE, not
    the production channel. Streams line-by-line, mirroring
    `db/provision/dump_tenant.py`'s own `run_mysqldump`, since a caller
    watching for a floor-table `INSERT` pattern needs whole lines.
    See dial_in_transport.md#localprocesstransport.
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
