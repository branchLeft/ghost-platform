#!/usr/bin/env python3
"""End-to-end proof, against a model of the commit pipeline, that a backup
taken while writes continue restores to a consistent point, with no lock
taken and the recovery position reported per tenant.

The model (db/provision/gtid_server_model.py) orders events; it is not a
database. The server-side claim it encodes, that the dump's GTID set is read
atomically with the snapshot, is proved against a real Percona server in a
container run, not here. What is proved here is everything this repository
adds around that claim. See db/provision/gtid_snapshot.md.
"""

from __future__ import annotations

import io
import pathlib
import random
import sys
import unittest

_DB_PROVISION = pathlib.Path(__file__).resolve().parents[3] / "db" / "provision"
sys.path.insert(0, str(_DB_PROVISION))

import backup_worker as bw  # noqa: E402
import dial_in_transport as dit  # noqa: E402
import extract_tenant_binlog as etb  # noqa: E402
import gtid_server_model as model  # noqa: E402
import gtid_snapshot as gs  # noqa: E402

TENANTS = ("a", "b", "c")
SCHEMA = {t: f"ghost_{t}" for t in TENANTS}


def transport(server: model.Server, *, snapshot: str = dit.SNAPSHOT_GTID) -> dit.RemoteMysqldumpTransport:
    return dit.RemoteMysqldumpTransport(
        host="db-t1", user="backup", ssl_ca="/ca.pem", popen=server.popen, snapshot=snapshot
    )


def dump(server: model.Server, tenant: str, via: dit.RemoteMysqldumpTransport | None = None):
    """One per-tenant dump through the real transport. Returns (exit code,
    dump text, the transport)."""
    via = via or transport(server)
    out = io.BytesIO()
    code = via.run(
        command=["python3", "dump_tenant.py", tenant, "--socket", "/s"],
        env={"DB_DUMP_MYSQL_PWD": "p"},
        stdout=out,
    )
    return code, out.getvalue().decode(), via


def position_dump(server: model.Server, tenant: str) -> str:
    """The retired recipe, for the control case: `--source-data=2` and a file
    and position, no GTID set."""
    factory = dit.bounded_snapshot.ClientFactory(connection_args=["--host", "x"], password="p", env={}, popen=server.popen)
    process = factory.spawn(
        "mysqldump",
        ["--single-transaction", "--source-data=2", "--databases", SCHEMA[tenant]],
    )
    return b"".join(process.stdout).decode()


def gtid_dump_text(server: model.Server, tenant: str) -> str:
    code, text, _ = dump(server, tenant)
    assert code == 0, f"the lock-free dump exited {code}"
    return text


def restore(server: model.Server, text: str, tenant: str, stop_ts: int | None, *, first_file: int = 1) -> dict:
    server.target = model.RestoreTarget()
    server.target.load_dump(text)
    etb.restore_point_in_time(
        dump_text=text,
        binlog_paths=server.binlog_paths(first=first_file),
        tenant_database=SCHEMA[tenant],
        stop_datetime=model.format_time(stop_ts) if stop_ts is not None else None,
        apply_host="restore",
        apply_user="root",
        apply_password="p",
        run=server.run,
        check_gap=True,
    )
    return server.target.rows(SCHEMA[tenant])


def restore_or_failure(server: model.Server, text: str, tenant: str, stop_ts: int | None):
    """The restored rows, or the replay's own failure as text. A lost row
    shows either way: the rows differ, or a later transaction that needs the
    lost one stops the replay. Neither equals the expected rows."""
    try:
        return restore(server, text, tenant, stop_ts)
    except etb.ExtractError as exc:
        return f"replay failed: {exc}"


def server_with_history(seed: int, *, warm: int = 20) -> tuple[model.Server, model.Workload]:
    server = model.Server()
    workload = model.Workload(server, list(SCHEMA.values()), seed)
    workload.run(warm)
    return server, workload


class StragglerTests(unittest.TestCase):
    """The case the design exists for: a transaction is in the binary log but
    not yet visible when the snapshot opens."""

    def setUp(self):
        self.server = model.Server()
        self.workload = model.Workload(self.server, list(SCHEMA.values()), seed=1)
        for _ in range(4):
            self.workload.write(SCHEMA["a"])
        self.server.drain()
        # Two of the tenant's transactions logged, not committed: invisible
        # to the snapshot, inside any file position read at that instant.
        self.workload.write(SCHEMA["a"])
        self.workload.write(SCHEMA["a"])
        self.assertEqual(len(self.server.pending()), 2)

        def activity():
            self.server.commit_next()
            self.workload.write()

        self.server.activity = activity

    def finish(self):
        self.server.activity = lambda: None
        self.server.drain()

    def test_a_gtid_dump_restores_every_committed_row_exactly_once(self):
        code, text, via = dump(self.server, "a")
        self.finish()
        self.assertEqual(code, 0)
        end = self.server.clock + 1
        self.assertEqual(restore(self.server, text, "a", end), self.server.expected_state(SCHEMA["a"], end))

    def test_the_file_and_position_recipe_loses_a_row_in_this_same_scenario(self):
        # Control: the harness can see the loss this design closes. The
        # position read at the instant includes the two logged-but-invisible
        # transactions, so a replay from it never applies them.
        text = position_dump(self.server, "a")
        self.finish()
        end = self.server.clock + 1
        restored = restore_or_failure(self.server, text, "a", end)
        self.assertNotEqual(restored, self.server.expected_state(SCHEMA["a"], end))

    def test_reading_the_set_after_the_snapshot_opened_loses_a_row(self):
        # Control: the ordering the design depends on. The same dump, but the
        # header carries the server's executed set read after the snapshot.
        self.server.header_set_source = "live_after"
        code, text, _ = dump(self.server, "a")
        self.finish()
        self.assertEqual(code, 0)
        end = self.server.clock + 1
        self.assertNotEqual(restore_or_failure(self.server, text, "a", end), self.server.expected_state(SCHEMA["a"], end))

    def test_the_set_is_exactly_what_the_snapshot_held(self):
        code, text, via = dump(self.server, "a")
        self.assertEqual(code, 0)
        # Four committed before the snapshot; the two logged ones and every
        # later one are not in it, however far the writers got during the dump.
        reported = gs.parse_gtid_set(via.last_snapshot.recovery_gtid_set)
        self.assertEqual(reported[model.SERVER_UUID], ((1, 4),))


class NoPauseTests(unittest.TestCase):
    def test_no_lock_is_taken_no_writer_waits_and_no_second_session_is_opened(self):
        server, workload = server_with_history(7)
        server.activity = workload.step
        for tenant in TENANTS:
            code, _, via = dump(server, tenant)
            self.assertEqual(code, 0)
            self.assertEqual((via.last_snapshot.lock_wait_seconds, via.last_snapshot.hold_seconds), (0.0, 0.0))
            self.assertEqual(via.last_snapshot.tables_locked, 0)
        self.assertEqual(server.spawned, ["mysqldump"] * 3)
        self.assertEqual((server.lock_requests, server.global_lock_attempts, server.stalled_submits), (0, 0, 0))

    def test_the_model_can_see_a_stall_when_there_is_one(self):
        # Control: the stall counter is not blind.
        server = model.Server()
        server.lock_tables(SCHEMA["a"])
        self.assertIsNone(server.submit(SCHEMA["a"], [("insert", "posts", 1, 1)]))
        self.assertEqual((server.lock_requests, server.stalled_submits), (1, 1))

    def test_a_stock_server_cannot_give_the_set_without_a_global_lock_and_fails_loudly(self):
        server, _ = server_with_history(3)
        server.flavour = "stock"
        code, text, via = dump(server, "a")
        self.assertNotEqual(code, 0)
        self.assertEqual(server.global_lock_attempts, 1)
        self.assertIsNone(via.last_snapshot.recovery_gtid_set)

    def test_a_dump_with_no_recovery_position_is_a_failure_not_a_backup(self):
        server, _ = server_with_history(3)
        server.header_set_source = "none"
        code, text, via = dump(server, "a")
        self.assertEqual(code, dit.SNAPSHOT_FAILED_EXIT_CODE)
        self.assertIsNone(via.last_snapshot.recovery_gtid_set)

    def test_the_bounded_mode_is_unchanged_by_default(self):
        self.assertEqual(dit.snapshot_mode_from_env({}), dit.SNAPSHOT_BOUNDED)
        self.assertEqual(dit.snapshot_mode_from_env({dit.SNAPSHOT_MODE_ENV: "gtid"}), dit.SNAPSHOT_GTID)
        with self.assertRaises(dit.DialInTransportError):
            dit.snapshot_mode_from_env({dit.SNAPSHOT_MODE_ENV: "lockless"})
        self.assertNotIn("--set-gtid-purged=ON", transport(model.Server(), snapshot=dit.SNAPSHOT_BOUNDED).dump_args("ghost_a"))


class RecoveryPositionTests(unittest.TestCase):
    def test_each_tenant_reports_its_own_position_and_it_matches_the_dump(self):
        server, workload = server_with_history(11)
        server.activity = workload.step
        positions = []
        for tenant in TENANTS:
            code, text, via = dump(server, tenant)
            self.assertEqual(code, 0)
            reported = via.last_snapshot.recovery_gtid_set
            self.assertEqual(gs.scan_dump_position(text.splitlines(keepends=True)), reported)
            positions.append(gs.parse_gtid_set(reported))
            workload.run(15)
        # Each later snapshot holds at least what the earlier one did, and the
        # positions differ: they are per snapshot, not one number for the run.
        for earlier, later in zip(positions, positions[1:]):
            self.assertTrue(gs.is_subset(earlier, later))
            self.assertNotEqual(earlier, later)

    def test_the_worker_reports_the_position_and_zero_lock_time(self):
        server, _ = server_with_history(5)
        code, _, via = dump(server, "a")
        measured = bw._snapshot_measurements(via, bw._LockWaitTimer())
        self.assertEqual(measured["recovery_gtid_set"], via.last_snapshot.recovery_gtid_set)
        self.assertEqual((measured["lock_wait_seconds"], measured["lock_hold_seconds"], measured["lock_aborts"]), (0.0, 0.0, 0))


class RestoreTests(unittest.TestCase):
    def test_other_tenants_events_never_reach_the_restored_tenant(self):
        server, workload = server_with_history(21, warm=40)
        server.activity = workload.step
        code, text, _ = dump(server, "a")
        server.activity = lambda: None
        server.drain()
        end = server.clock + 1
        restore(server, text, "a", end)
        self.assertEqual(set(server.target.state), {SCHEMA["a"]})

    def test_a_missing_early_binlog_file_is_refused_not_silently_under_replayed(self):
        server, workload = server_with_history(2, warm=60)
        self.assertGreater(server.file_number, 2)
        code, text, _ = dump(server, "a")
        workload.run(30)
        server.drain()
        with self.assertRaisesRegex(etb.ExtractError, "binlog gap"):
            restore(server, text, "a", None, first_file=server.file_number)

    def test_binlogs_written_without_gtids_are_refused(self):
        server, workload = server_with_history(2, warm=10)
        code, text, _ = dump(server, "a")
        server.gtid_binlogs = False
        with self.assertRaisesRegex(etb.ExtractError, "no Previous-GTIDs"):
            restore(server, text, "a", None)

    def test_restore_to_an_instant_inside_the_replay_stops_there(self):
        server, workload = server_with_history(9, warm=30)
        server.activity = workload.step
        code, text, _ = dump(server, "b")
        server.activity = lambda: None
        workload.run(40)
        server.drain()
        stop = server.clock - 10
        self.assertGreater(stop, 0)
        self.assertEqual(restore(server, text, "b", stop), server.expected_state(SCHEMA["b"], stop))

    def test_the_dump_alone_is_a_valid_restore_when_nothing_was_written_after(self):
        server, _ = server_with_history(4, warm=10)
        server.drain()
        code, text, _ = dump(server, "a")
        self.assertEqual(restore(server, text, "a", None), server.expected_state(SCHEMA["a"]))
        self.assertEqual(server.target.rows(SCHEMA["a"]), server.expected_state(SCHEMA["a"]))


class RandomInterleavingTests(unittest.TestCase):
    """The race is an ordering, so many orderings: each seed is a different
    schedule of writers, commits, snapshot and restore instant."""

    SEEDS = range(150)

    def run_seed(self, seed: int, *, recipe) -> list[str]:
        rng = random.Random(seed)
        server, workload = server_with_history(seed, warm=rng.randint(5, 35))
        server.activity = workload.step
        tenant = rng.choice(TENANTS)
        text = recipe(server, tenant)
        taken_at = server.snapshots[-1].ts
        server.activity = lambda: None
        workload.run(rng.randint(0, 30))
        server.drain()
        # A restore instant before the dump cannot be reached by replaying
        # forward, so the instant is drawn from after the snapshot.
        stop = rng.randint(taken_at + 1, server.clock + 1)
        restored = restore_or_failure(server, text, tenant, stop)
        want = server.expected_state(SCHEMA[tenant], stop)
        return [] if restored == want else [f"seed {seed} tenant {tenant}: restored {restored} wanted {want}"]

    def test_the_lock_free_dump_restores_consistently_under_every_schedule(self):
        failures: list[str] = []
        for seed in self.SEEDS:
            failures += self.run_seed(seed, recipe=gtid_dump_text)
        self.assertEqual(failures, [])

    def test_the_same_schedules_do_lose_rows_with_a_file_and_position(self):
        # Control: across these schedules the retired recipe loses rows, so
        # the pass above is not a pass by schedules too easy to fail.
        failures: list[str] = []
        for seed in self.SEEDS:
            failures += self.run_seed(seed, recipe=position_dump)
        # 56 of the 150 schedules lose or fail to replay when written; the
        # bar is far under that so a model tweak cannot make it flaky.
        self.assertGreater(len(failures), len(self.SEEDS) // 10)


if __name__ == "__main__":
    unittest.main()
