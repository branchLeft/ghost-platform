#!/usr/bin/env python3
"""Unit tests for nightly_dump_loop.py, through its real entry points --
`run_nightly_loop` and, separately, `main()` -- against the REAL
`db/provision/dump_tenant.py`, mirroring test_backup_worker.py's own
convention (fake `mysql`/`mysqldump` binaries on PATH, real `age`, real
`LocalProcessTransport`).
"""

from __future__ import annotations

import fcntl
import os
import pathlib
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

import backup_worker as bw
import nightly_dump_loop as loop
from dial_in_transport import LocalProcessTransport
from pull_encrypt_store import CopyTarget

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_DUMP_TENANT_PATH = str(_REPO_ROOT / "db" / "provision" / "dump_tenant.py")

_FAKE_MYSQL = "#!/bin/sh\necho 5\n"


def _write_fake_bin(directory: str, name: str, contents: str) -> None:
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(contents)
    os.chmod(path, 0o755)


def _happy_mysqldump(tenant: str) -> str:
    return (
        "#!/bin/sh\n"
        'echo "-- MySQL dump 10.13"\n'
        f'echo "INSERT INTO \\`users\\` VALUES (\'u-{tenant}\',\'Owner\');"\n'
        f'echo "INSERT INTO \\`settings\\` VALUES (\'s-{tenant}\',\'title\',\'{tenant}\');"\n'
        "exit 0\n"
    )


_FAILING_MYSQLDUMP = (
    "#!/bin/sh\n"
    'echo "-- MySQL dump 10.13 (--no-data)"\n'
    'echo "INSERT INTO \\`users\\` VALUES (\'u1\',\'Owner\');"\n'
    "exit 0\n"
)


def _generate_age_identity() -> tuple[str, str]:
    fd, path = tempfile.mkstemp(suffix=".age-key")
    os.close(fd)
    os.remove(path)
    result = subprocess.run(["age-keygen", "-o", path], capture_output=True, text=True, check=True)
    recipient = result.stderr.strip().rsplit(" ", 1)[-1]
    return path, recipient


class _FileCopy:
    def __init__(self, name: str, directory: str) -> None:
        self.name = name
        self.path = os.path.join(directory, f"{name}.age")

    def put(self, ciphertext: bytes) -> None:
        with open(self.path, "wb") as handle:
            handle.write(ciphertext)

    def as_target(self) -> CopyTarget:
        return CopyTarget(name=self.name, put=self.put)


class TenantSourceTests(unittest.TestCase):
    def test_dedupe_preserves_first_occurrence_order(self) -> None:
        self.assertEqual(
            loop._dedupe_preserving_order(["shop", "blog", "shop", "cafe", "blog"]),
            ["shop", "blog", "cafe"],
        )

    def test_tenants_file_skips_blank_lines_and_comments(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "tenants.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("blog\n\n# a comment\nshop\n  \ncafe\n")
            self.assertEqual(loop._read_tenants_file(path), ["blog", "shop", "cafe"])

    def test_main_combines_repeatable_tenant_and_tenants_file(self) -> None:
        """Through main()'s own argument parsing -- proves --tenant and
        --tenants-file are additive and de-duplicated, not one overriding
        the other."""
        with tempfile.TemporaryDirectory() as tmp:
            file_path = os.path.join(tmp, "tenants.txt")
            with open(file_path, "w", encoding="utf-8") as handle:
                handle.write("shop\nblog\n")

            captured: list[str] = []

            def fake_run_nightly_loop(*, tenants, **kwargs):
                captured.extend(tenants)
                return []

            with mock.patch.object(loop, "run_nightly_loop", fake_run_nightly_loop):
                with mock.patch.dict(
                    os.environ,
                    {"DB_DUMP_MYSQL_PWD": "x", "AGE_RECIPIENT_PUBLIC_KEY": "x"},
                ):
                    exit_code = loop.main(
                        [
                            "--tenant",
                            "blog",
                            "--tenant",
                            "cafe",
                            "--tenants-file",
                            file_path,
                            "--run-lock-path",
                            os.path.join(tmp, "run.lock"),
                            "--local-test-transport",
                        ]
                    )
        # blog named twice (once directly, once via the file) collapses to one.
        self.assertEqual(captured, ["blog", "cafe", "shop"])
        self.assertEqual(exit_code, 0)  # fake_run_nightly_loop returns [] -> vacuously "all ok"

    def test_no_tenants_named_refuses_before_touching_the_transport(self) -> None:
        self.assertEqual(loop.main([]), 1)


class _RealProducerLoopTestCase(unittest.TestCase):
    """Shared setup for tests that run the real db/provision/dump_tenant.py
    through LocalProcessTransport, mirroring test_backup_worker.py."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(self.bin_dir)
        _write_fake_bin(self.bin_dir, "mysql", _FAKE_MYSQL)

        _, self.recipient = _generate_age_identity()
        self.copies_dir = os.path.join(self.tmp.name, "copies")
        os.makedirs(self.copies_dir)
        self.metrics_dir = os.path.join(self.tmp.name, "metrics")

        self._path_patch = mock.patch.dict(
            os.environ, {"PATH": self.bin_dir + os.pathsep + os.environ.get("PATH", "")}
        )
        self._path_patch.start()
        self.addCleanup(self._path_patch.stop)

    def _copies_for(self, tenant: str) -> list[CopyTarget]:
        return [_FileCopy(f"{tenant}-primary", self.copies_dir).as_target()]

    def _run_loop(self, tenants: list[str]) -> list[loop.TenantOutcome]:
        with mock.patch.object(bw, "_copies_from_env", side_effect=lambda *, tenant: self._copies_for(tenant)):
            return loop.run_nightly_loop(
                tenants=tenants,
                transport=LocalProcessTransport(),
                mysql_pwd="irrelevant-fake-password",
                age_recipient=self.recipient,
                dump_tenant_path=_DUMP_TENANT_PATH,
                socket_path=bw.DEFAULT_SOCKET,
                metrics_dir=self.metrics_dir,
            )


class SerialExecutionProofTests(_RealProducerLoopTestCase):
    """Proves tenants are dumped ONE AT A TIME -- against real wall-clock
    behaviour, not just code inspection. Each tenant's fake mysqldump
    records its own [start, end] interval (via a shared, append-only file
    every invocation opens in append mode -- safe under real concurrency
    because O_APPEND writes are atomic for a write this small) with a
    sleep in between; overlapping intervals would mean two tenants' dumps
    ran at once."""

    def _intervals_mysqldump(self, marker_path: str) -> str:
        # Each invocation tags its two lines with its own PID, so
        # concurrent runs interleaving as start/start/start/end/end/end
        # (rather than the serial start/end/start/end/.../end this shape
        # would produce) can still be paired up correctly by the reader --
        # pairing by LINE POSITION alone would silently mismatch exactly
        # that interleave.
        python_snippet = (
            "import os, time\n"
            "pid = os.getpid()\n"
            f"with open('{marker_path}', 'a') as f:\n"
            "    f.write('start %s %s\\n' % (pid, time.monotonic()))\n"
            "time.sleep(0.15)\n"
            f"with open('{marker_path}', 'a') as f:\n"
            "    f.write('end %s %s\\n' % (pid, time.monotonic()))\n"
        )
        return (
            "#!/bin/sh\n"
            f'python3 -c "\n{python_snippet}"\n'
            'echo "-- MySQL dump 10.13"\n'
            'echo "INSERT INTO \\`users\\` VALUES (\'u1\',\'Owner\');"\n'
            'echo "INSERT INTO \\`settings\\` VALUES (\'s1\',\'title\',\'x\');"\n'
            "exit 0\n"
        )

    @staticmethod
    def _read_intervals(marker_path: str) -> list[tuple[float, float]]:
        """Pairs each PID's `start`/`end` line, whatever order they were
        interleaved in on disk -- see `_intervals_mysqldump`'s own
        comment on why pairing by line position would be wrong here."""
        starts: dict[str, float] = {}
        ends: dict[str, float] = {}
        with open(marker_path, encoding="utf-8") as handle:
            for line in handle:
                parts = line.split()
                if len(parts) != 3:
                    continue
                label, pid, ts = parts
                (starts if label == "start" else ends)[pid] = float(ts)
        return [(starts[pid], ends[pid]) for pid in starts if pid in ends]

    def test_no_two_tenants_dumps_overlap(self) -> None:
        marker_path = os.path.join(self.tmp.name, "markers.txt")
        _write_fake_bin(self.bin_dir, "mysqldump", self._intervals_mysqldump(marker_path))

        outcomes = self._run_loop(["blog", "shop", "cafe"])
        self.assertTrue(all(outcome.ok for outcome in outcomes), outcomes)

        starts_ends = self._read_intervals(marker_path)
        self.assertEqual(len(starts_ends), 3)
        ordered = sorted(starts_ends)
        for (_, end), (next_start, _) in zip(ordered, ordered[1:]):
            self.assertLessEqual(end, next_start, f"overlap detected: {starts_ends}")

    def test_sabotage_a_concurrent_caller_would_overlap(self) -> None:
        """RED, reproduced directly rather than by editing the shipped
        file: what calling the SAME per-tenant dump concurrently (a thread
        pool instead of run_nightly_loop's plain for-loop) would produce.
        This is not a claim about nightly_dump_loop.py's own code -- it is
        the control case proving the underlying producer really can
        overlap if something calls it that way, which is what makes the
        for-loop's seriality a real property rather than an accident of
        the fake producer being fast."""
        marker_path = os.path.join(self.tmp.name, "markers.txt")
        _write_fake_bin(self.bin_dir, "mysqldump", self._intervals_mysqldump(marker_path))

        def dump_one(tenant: str) -> None:
            # Calls bw.run_tenant_dump directly (not self._run_loop / the
            # mock.patch.object seam), because mock.patch.object's own
            # setUp/tearDown is not safe to enter from several threads at
            # once -- irrelevant to what this control case is proving,
            # which is the underlying producer's own ability to overlap.
            bw.run_tenant_dump(
                tenant=tenant,
                transport=LocalProcessTransport(),
                mysql_pwd="irrelevant-fake-password",
                age_recipient=self.recipient,
                copies=self._copies_for(tenant),
                dump_tenant_path=_DUMP_TENANT_PATH,
                socket_path=bw.DEFAULT_SOCKET,
            )

        threads = [threading.Thread(target=dump_one, args=(t,)) for t in ["blog", "shop", "cafe"]]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        starts_ends = self._read_intervals(marker_path)
        self.assertEqual(len(starts_ends), 3)
        ordered = sorted(starts_ends)
        overlapped = any(end > next_start for (_, end), (next_start, _) in zip(ordered, ordered[1:]))
        self.assertTrue(overlapped, "expected the concurrent-caller control case to overlap")


class RunLockTests(unittest.TestCase):
    """The whole-run lock that refuses a second, overlapping invocation of
    this script -- see the module docstring's point 2."""

    def test_a_second_attempt_while_the_first_holds_the_lock_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = os.path.join(tmp, "run.lock")
            with loop._RunLock(lock_path):
                with self.assertRaises(loop.NightlyLoopAlreadyRunning):
                    with loop._RunLock(lock_path):
                        pass

    def test_the_lock_is_released_on_exit_and_a_later_run_can_acquire_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = os.path.join(tmp, "run.lock")
            with loop._RunLock(lock_path):
                pass
            with loop._RunLock(lock_path):
                pass  # must not raise

    def test_sabotage_a_blocking_flock_queues_instead_of_refusing(self) -> None:
        """RED, reproduced directly: `fcntl.flock` WITHOUT `LOCK_NB` --
        what dropping that flag from `_RunLock.__enter__` would do. Instead
        of `NightlyLoopAlreadyRunning` being raised immediately, a second
        caller silently BLOCKS until the first releases, which is exactly
        the queuing-up-behind-a-stuck-run failure the module docstring
        says refusing is meant to avoid. Proven by showing the second
        caller has NOT returned after a short timeout while the first
        still holds the lock, then showing it proceeds once released."""
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = os.path.join(tmp, "run.lock")

            first_handle = open(lock_path, "a+", encoding="utf-8")
            fcntl.flock(first_handle.fileno(), fcntl.LOCK_EX)

            second_acquired = threading.Event()

            def blocking_second_attempt() -> None:
                handle = open(lock_path, "a+", encoding="utf-8")
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)  # no LOCK_NB -- the sabotaged shape
                second_acquired.set()
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                handle.close()

            thread = threading.Thread(target=blocking_second_attempt)
            thread.start()
            self.assertFalse(second_acquired.wait(timeout=0.3), "a non-blocking refusal would never reach this point")

            fcntl.flock(first_handle.fileno(), fcntl.LOCK_UN)
            first_handle.close()
            thread.join(timeout=5)
            self.assertTrue(second_acquired.is_set())


class ResilienceTests(_RealProducerLoopTestCase):
    """One tenant's failure must never stop the rest of the run."""

    def test_a_crashing_tenant_does_not_stop_the_ones_after_it(self) -> None:
        _write_fake_bin(self.bin_dir, "mysqldump", _happy_mysqldump("ok"))
        real_run_tenant_dump = bw.run_tenant_dump

        def flaky(*, tenant, **kwargs):
            if tenant == "shop":
                raise RuntimeError("simulated transport crash for shop")
            return real_run_tenant_dump(tenant=tenant, **kwargs)

        with mock.patch.object(bw, "run_tenant_dump", flaky):
            outcomes = self._run_loop(["blog", "shop", "cafe"])

        self.assertEqual([o.tenant for o in outcomes], ["blog", "shop", "cafe"])
        self.assertTrue(outcomes[0].ok)
        self.assertFalse(outcomes[1].ok)
        self.assertTrue(outcomes[1].crashed)
        self.assertIn("simulated transport crash", outcomes[1].error)
        self.assertTrue(outcomes[2].ok)

    def test_sabotage_no_try_except_aborts_the_whole_loop_on_one_crash(self) -> None:
        """RED, reproduced directly: the pre-fix shape of the loop with no
        per-tenant try/except at all -- what deleting
        `_dump_one_tenant`'s `try`/`except Exception` would do. The third
        tenant is never even attempted."""
        _write_fake_bin(self.bin_dir, "mysqldump", _happy_mysqldump("ok"))
        real_run_tenant_dump = bw.run_tenant_dump

        def flaky(*, tenant, **kwargs):
            if tenant == "shop":
                raise RuntimeError("simulated transport crash for shop")
            return real_run_tenant_dump(tenant=tenant, **kwargs)

        attempted: list[str] = []
        with mock.patch.object(bw, "run_tenant_dump", flaky):
            with mock.patch.object(bw, "_copies_from_env", side_effect=lambda *, tenant: self._copies_for(tenant)):
                with self.assertRaises(RuntimeError):
                    for tenant in ["blog", "shop", "cafe"]:
                        attempted.append(tenant)
                        bw.run_tenant_dump(
                            tenant=tenant,
                            transport=LocalProcessTransport(),
                            mysql_pwd="irrelevant-fake-password",
                            age_recipient=self.recipient,
                            copies=self._copies_for(tenant),
                            dump_tenant_path=_DUMP_TENANT_PATH,
                            socket_path=bw.DEFAULT_SOCKET,
                        )
        self.assertEqual(attempted, ["blog", "shop"])  # cafe never reached


# Reads --databases from its own argv and decides happy vs. floor-failing
# by tenant, so a single fake binary serves every tenant in one
# run_nightly_loop call without needing to rewrite the file on PATH
# mid-run (dump_tenant.py runs as its own subprocess, so a rewrite timed
# from the test process would be racing that subprocess's own startup).
_DISPATCHING_MYSQLDUMP = (
    "#!/bin/sh\n"
    'db=""\n'
    'prev=""\n'
    'for a in "$@"; do\n'
    '  if [ "$prev" = "--databases" ]; then\n'
    '    db="$a"\n'
    "  fi\n"
    '  prev="$a"\n'
    "done\n"
    'echo "-- MySQL dump 10.13"\n'
    'echo "INSERT INTO \\`users\\` VALUES (\'u1\',\'Owner\');"\n'
    'if [ "$db" != "ghost_shop" ]; then\n'
    '  echo "INSERT INTO \\`settings\\` VALUES (\'s1\',\'title\',\'x\');"\n'
    "fi\n"
    "exit 0\n"
)


class MetricsWiringThroughLoopTests(_RealProducerLoopTestCase):
    """Proves the loop records both metrics through the SAME functions
    backup_worker.main() uses, per-tenant, with the same success/failure
    gating as that entry point."""

    def _read_ages(self) -> dict[str, float]:
        path = pathlib.Path(self.metrics_dir) / bw.BACKUP_AGE_METRIC_FILENAME
        if not path.exists():
            return {}
        return bw._parse_previous_backup_age_metrics(path.read_text())

    def _read_waits(self) -> dict[str, float]:
        path = pathlib.Path(self.metrics_dir) / bw.BACKUP_LOCK_WAIT_METRIC_FILENAME
        if not path.exists():
            return {}
        return bw._parse_previous_lock_wait_metrics(path.read_text())

    def test_a_successful_and_a_failed_tenant_in_the_same_run(self) -> None:
        _write_fake_bin(self.bin_dir, "mysqldump", _DISPATCHING_MYSQLDUMP)

        outcomes = self._run_loop(["blog", "shop"])

        self.assertTrue(outcomes[0].ok, outcomes[0].error)
        self.assertFalse(outcomes[1].ok)

        ages = self._read_ages()
        waits = self._read_waits()
        self.assertIn("blog", ages)
        self.assertNotIn("shop", ages)  # failed dump -> no backup-age gauge
        self.assertIn("blog", waits)
        self.assertIn("shop", waits)  # failed dump -> STILL a lock-wait gauge



class ReportLineTests(unittest.TestCase):
    def test_an_ok_tenant_reports_its_wait_hold_and_aborts(self) -> None:
        result = bw.DumpResult(
            tenant="blog", ok=True, exit_code=0, floor_tables_seen=frozenset(), missing_floor_tables=frozenset(),
            copies_written=("primary",), error=None, lock_wait_seconds=0.25, lock_hold_seconds=0.125, lock_aborts=2,
        )
        line = loop._report_line(loop.TenantOutcome(tenant="blog", result=result, crashed=False, error=None))
        self.assertIn("lock wait 0.250s, hold 0.125s, 2 aborted lock attempt(s)", line)

    def test_an_unmeasured_hold_says_so(self) -> None:
        result = bw.DumpResult(
            tenant="blog", ok=True, exit_code=0, floor_tables_seen=frozenset(), missing_floor_tables=frozenset(),
            copies_written=("primary",), error=None,
        )
        line = loop._report_line(loop.TenantOutcome(tenant="blog", result=result, crashed=False, error=None))
        self.assertIn("lock wait unmeasured, hold unmeasured, 0 aborted", line)

if __name__ == "__main__":
    unittest.main()
