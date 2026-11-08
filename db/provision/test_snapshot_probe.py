#!/usr/bin/env python3
"""Unit tests for snapshot_probe.py, no Docker. The six controls are judged
by pure verdict functions; each is asserted here against a sabotage fixture
(a 10 s stall, a GLOBAL lock row, mismatched checksums, an accepted FTWRL, a
writer waiting 10 s) that must FAIL and a healthy fixture that must PASS, so
a verdict that quietly stopped judging turns this suite red. The Docker run
itself is hand-run: prove-snapshot-locking.sh, snapshot_probe.md."""

from __future__ import annotations

import importlib.util
import inspect
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

import bounded_snapshot as bs
import snapshot_probe as sp

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_RUNBOOK = (_REPO_ROOT / "db" / "RUNBOOK-db.md").read_text(encoding="utf-8")
_PROMOTION_PROOF = (_REPO_ROOT / "db" / "provision" / "prove-promotion-gate.sh").read_text(encoding="utf-8")
_PROOF_SCRIPT_PATH = _REPO_ROOT / "db" / "provision" / "prove-snapshot-locking.sh"
_PROOF_SCRIPT = _PROOF_SCRIPT_PATH.read_text(encoding="utf-8")
_DIAL_IN_TRANSPORT = _REPO_ROOT / "infra" / "provisioning" / "scripts" / "dial_in_transport.py"


def _dial_in_transport():
    """The real per-tenant channel's module, by path, as its own tests load it."""
    spec = importlib.util.spec_from_file_location("dial_in_transport", _DIAL_IN_TRANSPORT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _docker_must_not_be_asked() -> str:
    raise AssertionError("docker was asked for its context")
# Stands in for docker: logs every call, reports one context, fails the rest.
_FAKE_DOCKER = """#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = context ]; then echo "$FAKE_DOCKER_CONTEXT"; fi
exit 1
"""


class ClientDeadlineTests(unittest.TestCase):
    def test_the_server_bound_firing_first_fails_the_two_table_case(self) -> None:
        first = "bounded_snapshot: attempt 1/5 aborted: server gave up the lock wait after 1s"
        self.assertFalse(sp.client_deadline_verdict(first, 1.2).passed)

    def test_the_client_deadline_firing_first_passes_the_two_table_case(self) -> None:
        first = "bounded_snapshot: attempt 1/5 aborted: lock not granted within 1.2s"
        self.assertTrue(sp.client_deadline_verdict(first, 1.2).passed)

    def test_no_abort_at_all_is_never_a_pass(self) -> None:
        self.assertFalse(sp.client_deadline_verdict(None, 1.2).passed)


class ProofScriptRefusalTests(unittest.TestCase):
    def _run(self, *, docker_host: str | None, context: str) -> tuple[subprocess.CompletedProcess, str]:
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp) / "docker"
            fake.write_text(_FAKE_DOCKER, encoding="utf-8")
            fake.chmod(0o755)
            log = pathlib.Path(tmp) / "calls.log"
            env = {key: value for key, value in os.environ.items() if key != "DOCKER_HOST"}
            env.update(
                PATH=f"{tmp}{os.pathsep}{os.environ.get('PATH', '')}",
                FAKE_DOCKER_LOG=str(log),
                FAKE_DOCKER_CONTEXT=context,
            )
            if docker_host is not None:
                env["DOCKER_HOST"] = docker_host
            result = subprocess.run(
                ["bash", str(_PROOF_SCRIPT_PATH)], env=env, capture_output=True, text=True, check=False, timeout=120
            )
            calls = log.read_text(encoding="utf-8") if log.exists() else ""
            return result, calls

    def test_an_ambient_docker_host_is_refused_before_any_docker_call(self) -> None:
        result, calls = self._run(docker_host="tcp://192.0.2.10:2376", context="desktop-linux")
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertIn("DOCKER_HOST", result.stderr)
        self.assertEqual(calls, "")

    def test_a_non_local_docker_context_is_refused_before_any_container(self) -> None:
        result, calls = self._run(docker_host=None, context="remote-prod")
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertIn("remote-prod", result.stderr)
        self.assertEqual(calls.strip(), "context show")

    def test_the_local_desktop_context_is_not_refused(self) -> None:
        result, calls = self._run(docker_host=None, context="desktop-linux")
        self.assertNotEqual(result.returncode, 5, result.stderr)
        self.assertIn("network create", calls)


class SabotageFixturesTests(unittest.TestCase):
    def test_every_canned_case_behaves(self) -> None:
        self.assertEqual(sp.self_test(), [])

    def test_each_verdict_has_a_red_and_a_green_case(self) -> None:
        by_verdict: dict[str, set[bool]] = {}
        for label, expected, _ in sp.SELF_TEST_CASES:
            by_verdict.setdefault(label.split(":")[0], set()).add(expected)
        self.assertEqual(
            set(by_verdict),
            {"writer_stall", "control_2_report", "checksum", "global_lock", "scoped_grant", "bounded_wait", "retry"},
        )
        for name, outcomes in by_verdict.items():
            self.assertEqual(outcomes, {True, False}, f"{name} needs both a sabotage and a healthy fixture")

    def test_a_ten_second_stall_fails_control_two(self) -> None:
        verdict = sp.writer_stall_verdict([0.005, 10.2, 0.004], sp.WRITER_LIMIT_SECONDS)
        self.assertFalse(verdict.passed)
        self.assertIn("10200.0 ms", verdict.reason)

    def test_a_global_lock_row_fails_control_three(self) -> None:
        sabotage = [("TABLE", "SHARED_READ_ONLY", "GRANTED"), ("GLOBAL", "SHARED", "GRANTED")]
        self.assertFalse(sp.global_lock_verdict(sabotage).passed)
        self.assertFalse(sp.global_lock_verdict([("TABLE", "SHARED_READ_ONLY", "GRANTED"), ("COMMIT", "SHARED", "GRANTED")]).passed)

    def test_mismatched_checksums_fail_control_one(self) -> None:
        verdict = sp.checksum_verdict({"posts": (5, 1)}, {"posts": (5, 2)})
        self.assertFalse(verdict.passed)
        self.assertIn("posts", verdict.reason)

    def test_an_accepted_ftwrl_fails_control_four(self) -> None:
        self.assertFalse(sp.scoped_grant_verdict(1142, 0, []).passed)

    def test_a_writer_waiting_ten_seconds_fails_control_five(self) -> None:
        verdict = sp.bounded_wait_verdict([0.01, 10.0], sp.MODULE_WAIT_BOUND_SECONDS, sp.BODY_WAIT_CEILING_SECONDS)
        self.assertFalse(verdict.passed)


class VerdictEdgeTests(unittest.TestCase):
    def test_a_blind_probe_is_never_a_pass(self) -> None:
        self.assertFalse(sp.writer_stall_verdict([], 0.1).passed)
        self.assertFalse(sp.bounded_wait_verdict([], 1.8, 2.0).passed)
        self.assertFalse(sp.global_lock_verdict([]).passed)
        self.assertFalse(sp.checksum_verdict({}, {}).passed)

    def test_the_stall_limit_is_inclusive(self) -> None:
        self.assertTrue(sp.writer_stall_verdict([0.1], 0.1).passed)
        self.assertFalse(sp.writer_stall_verdict([0.1001], 0.1).passed)

    def test_a_lock_sampler_that_saw_only_pending_table_locks_was_blind(self) -> None:
        self.assertFalse(sp.global_lock_verdict([("TABLE", "SHARED_READ_ONLY", "PENDING")]).passed)

    def test_a_backup_lock_row_is_not_a_global_lock(self) -> None:
        rows = [("TABLE", "SHARED_READ_ONLY", "GRANTED"), ("BACKUP LOCK", "SHARED", "GRANTED")]
        self.assertTrue(sp.global_lock_verdict(rows).passed)

    def test_checksum_table_set_differences_fail(self) -> None:
        self.assertFalse(sp.checksum_verdict({"a": (1, 1), "b": (1, 1)}, {"a": (1, 1)}).passed)
        self.assertFalse(sp.checksum_verdict({"a": (1, 1)}, {"a": (1, 1), "b": (1, 1)}).passed)

    def test_each_scoped_grant_failure_is_named(self) -> None:
        self.assertIn("1142", sp.scoped_grant_verdict(0, 1227, []).reason)
        self.assertIn("1227", sp.scoped_grant_verdict(1142, 0, []).reason)
        self.assertIn("clone", sp.scoped_grant_verdict(1142, 1227, ["clone"]).reason)
        self.assertIn("RELOAD", sp.scoped_grant_verdict(1142, 1227, [], ["BACKUP_ADMIN", "RELOAD"]).reason)
        self.assertFalse(sp.scoped_grant_verdict(1142, 1227, [], []).passed)

    def test_the_wait_is_judged_against_both_the_module_bound_and_the_body_ceiling(self) -> None:
        # Past the module's bound but inside the body's: fails on the module.
        inside_body = sp.bounded_wait_verdict([2.1], 1.8, 2.5, margin=0.0)
        self.assertFalse(inside_body.passed)
        self.assertIn("module", inside_body.reason)
        # Inside the module's (looser) bound but past the body's: fails on the body.
        past_body = sp.bounded_wait_verdict([2.4], 3.0, 2.0, margin=0.0)
        self.assertFalse(past_body.passed)
        self.assertIn("body", past_body.reason)

    def test_the_margin_is_allowed_and_no_more(self) -> None:
        self.assertTrue(sp.bounded_wait_verdict([1.8 + sp.MEASUREMENT_MARGIN_SECONDS], 1.8, 2.0).passed)
        self.assertFalse(sp.bounded_wait_verdict([1.8 + sp.MEASUREMENT_MARGIN_SECONDS + 0.01], 1.8, 2.0).passed)

    def test_the_retry_must_follow_an_abort_and_the_end_of_the_transaction(self) -> None:
        self.assertFalse(sp.retry_verdict(0, 1, True).passed)
        self.assertFalse(sp.retry_verdict(5, 5, True).passed)
        self.assertFalse(sp.retry_verdict(1, 2, False).passed)
        self.assertTrue(sp.retry_verdict(1, 2, True).passed)

    def test_latencies_between_counts_a_statement_straddling_the_window(self) -> None:
        samples = [(0.0, 0.01), (4.0, 3.0), (9.0, 0.02), (20.0, 0.01)]
        self.assertEqual(sp.latencies_between(samples, 5.0, 10.0), [3.0, 0.02])

    def test_the_ddl_finding_says_whether_dml_queued(self) -> None:
        queued = sp.ddl_finding(
            alter_seconds=4.0, hold_remaining_seconds=4.0, altered_table_worst=3.9, other_table_worst=0.02, blog_worst=0.02, hold_only_worst=0.02
        )
        self.assertTrue(queued.alter_waited)
        self.assertTrue(queued.altered_table_queues)
        self.assertIn("QUEUED", queued.text)
        free = sp.ddl_finding(
            alter_seconds=4.0, hold_remaining_seconds=4.0, altered_table_worst=0.05, other_table_worst=0.02, blog_worst=0.02, hold_only_worst=0.02
        )
        self.assertTrue(free.alter_waited)
        self.assertFalse(free.altered_table_queues)
        immediate = sp.ddl_finding(
            alter_seconds=0.05, hold_remaining_seconds=4.0, altered_table_worst=0.05, other_table_worst=0.02, blog_worst=0.02, hold_only_worst=0.02
        )
        self.assertFalse(immediate.alter_waited)


class ParsingTests(unittest.TestCase):
    def test_errno_is_the_first_error_printed(self) -> None:
        self.assertEqual(sp.parse_errno("ERROR 1227 (42000) at line 1: Access denied; you need RELOAD"), 1227)
        self.assertEqual(sp.parse_errno(""), 0)
        self.assertEqual(sp.parse_errno("mysql: [Warning] Using a password on the command line"), 0)

    def test_global_privileges_ignore_usage_and_narrower_grants(self) -> None:
        lines = [
            "GRANT USAGE ON *.* TO `mover`@`localhost`",
            "GRANT BACKUP_ADMIN ON *.* TO `mover`@`localhost`",
            "GRANT SELECT, LOCK TABLES ON `blog`.* TO `mover`@`localhost`",
            "GRANT SELECT ON `performance_schema`.`log_status` TO `mover`@`localhost`",
        ]
        self.assertEqual(sp.parse_global_privileges(lines), frozenset({"BACKUP_ADMIN"}))
        lines.append("GRANT RELOAD, REPLICATION CLIENT ON *.* TO `mover`@`localhost`")
        self.assertEqual(sp.parse_global_privileges(lines), frozenset({"BACKUP_ADMIN", "RELOAD", "REPLICATION CLIENT"}))

    def test_exit_codes(self) -> None:
        self.assertEqual(sp.exit_code({1: True, 2: True, 3: True, 4: True, 5: True, 6: True}, sabotaged=False), sp.EXIT_PASSED)
        for number in (1, 2, 3, 4, 5):
            outcomes = {n: True for n in range(1, 7)}
            outcomes[number] = False
            self.assertEqual(sp.exit_code(outcomes, sabotaged=False), sp.EXIT_OPTION_C_UNAVAILABLE, number)
        self.assertEqual(sp.exit_code({6: False}, sabotaged=False), sp.EXIT_FINDING_NOT_RECORDED)
        self.assertEqual(sp.exit_code({2: False, 3: False}, sabotaged=True), sp.EXIT_RED)
        self.assertEqual(sp.exit_code({2: False, 3: True}, sabotaged=True), sp.EXIT_SABOTAGE_NOT_DETECTED)

    def test_every_sabotage_targets_a_gating_control(self) -> None:
        for name, targets in sp.SABOTAGE_TARGETS.items():
            self.assertTrue(set(targets) <= set(sp.GATING_CONTROLS), name)
            self.assertTrue(set(targets) <= set(sp.CONTROLS), name)


class SchemaTests(unittest.TestCase):
    def test_the_blog_schema_is_fourteen_tables_with_a_trigger_and_a_view(self) -> None:
        ddl = sp.blog_ddl()
        created = re.findall(r"CREATE TABLE (\w+)", ddl)
        self.assertEqual(len(created), 14)
        self.assertEqual(set(created), set(sp.BLOG_TABLES))
        self.assertEqual(ddl.count("CREATE TRIGGER"), 1)
        self.assertEqual(ddl.count("CREATE VIEW"), 1)
        self.assertIn("FOREIGN KEY", ddl)

    def test_the_other_schema_is_a_separate_set_of_tables(self) -> None:
        self.assertIn("CREATE DATABASE other", sp.other_ddl())
        self.assertNotIn(sp.BLOG, sp.other_ddl().replace("CREATE DATABASE other", ""))

    def test_the_writer_transaction_touches_several_tables(self) -> None:
        statement = sp.blog_statement("w1", 7)
        for table in ("posts", "emails", "settings"):
            self.assertIn(table, statement)
        self.assertTrue(statement.startswith("START TRANSACTION") and statement.endswith("COMMIT;"))


class DigestAndBoundsTests(unittest.TestCase):
    def test_the_runbook_pins_one_digest(self) -> None:
        self.assertRegex(sp.pinned_image(_RUNBOOK), r"^mysql:8\.0@sha256:[0-9a-f]{64}$")

    def test_pinned_image_refuses_zero_or_two_digests(self) -> None:
        with self.assertRaises(ValueError):
            sp.pinned_image("no pin here")
        with self.assertRaises(ValueError):
            sp.pinned_image("mysql:8.0@sha256:" + "a" * 64 + " mysql:8.0@sha256:" + "b" * 64)

    def test_the_promotion_gate_proof_still_pins_the_runbooks_digest(self) -> None:
        self.assertEqual(sp.pinned_image(_PROMOTION_PROOF), sp.pinned_image(_RUNBOOK))

    def test_the_proof_script_reads_the_digest_and_never_copies_it(self) -> None:
        self.assertNotIn("sha256:", _PROOF_SCRIPT.replace("mysql:8\\.0@sha256:[0-9a-f]{64}", ""))
        self.assertIn("db/RUNBOOK-db.md", _PROOF_SCRIPT)

    def test_the_proof_script_parses(self) -> None:
        result = subprocess.run(["bash", "-n", str(_PROOF_SCRIPT_PATH)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_proof_script_never_writes_a_password_into_a_file_or_argv(self) -> None:
        for line in _PROOF_SCRIPT.splitlines():
            if line.lstrip().startswith("#"):
                continue
            self.assertIsNone(re.search(r"(?i)(password|pwd)\w*=[\"']?[A-Za-z0-9!]{4,}", line), line)
        self.assertIn("openssl rand", _PROOF_SCRIPT)

    def test_the_proof_script_touches_only_local_containers(self) -> None:
        for forbidden in ("ssh ", "ansible", "hcloud", "pulumi", "scp ", "rsync"):
            self.assertNotIn(forbidden, _PROOF_SCRIPT)
        self.assertNotIn("docker -H", _PROOF_SCRIPT)
        # The script refuses DOCKER_HOST; it never sets or exports it.
        self.assertIn('[ -z "${DOCKER_HOST:-}" ] || {', _PROOF_SCRIPT)
        self.assertNotIn("DOCKER_HOST=", _PROOF_SCRIPT)
        self.assertNotIn("export DOCKER_HOST", _PROOF_SCRIPT)

    def test_the_shipped_wait_is_stricter_than_the_bodys_two_seconds(self) -> None:
        # The ticket body says 2 s; the module's LOCK_WAIT_TIMEOUT_SECONDS is 1
        # and its wait plus hold stays under 2 s. The proof asserts both.
        self.assertEqual(bs.LOCK_WAIT_TIMEOUT_SECONDS, 1)
        self.assertLess(sp.MODULE_WAIT_BOUND_SECONDS, sp.BODY_WAIT_CEILING_SECONDS)
        self.assertEqual(sp.MODULE_WAIT_BOUND_SECONDS, round(bs.WAIT_DEADLINE_SECONDS + bs.HOLD_BOUND_SECONDS, 3))


class PasswordHandlingTests(unittest.TestCase):
    def test_the_password_never_reaches_a_command_line(self) -> None:
        server = sp.Server("container-1", "hunter2-root")
        argv = server.exec_argv(["mysql", "--user=root"], interactive=True)
        self.assertEqual(argv[:5], ["docker", "exec", "-i", "-e", "MYSQL_PWD"])
        self.assertNotIn("hunter2-root", " ".join(argv))
        self.assertEqual(sp._client_env("hunter2-root")["MYSQL_PWD"], "hunter2-root")

    def test_the_popen_shim_moves_the_option_file_password_into_the_environment(self) -> None:
        seen = {}

        class Recorder(sp.Server):
            def popen(self, inner, password, **kwargs):
                seen.update(inner=list(inner), password=password, kwargs=kwargs)
                return object()

        factory = bs.ClientFactory(
            connection_args=["--user=mover"], password="mover-secret", env={}, popen=sp.container_popen(Recorder("c", "root"))
        )
        factory.spawn("mysql", ["--batch"], stdin=subprocess.PIPE)
        self.assertEqual(seen["inner"], ["mysql", "--user=mover", "--batch"])
        self.assertEqual(seen["password"], "mover-secret")
        self.assertNotIn("mover-secret", " ".join(seen["inner"]))
        self.assertNotIn("env", seen["kwargs"])
        self.assertNotIn("pass_fds", seen["kwargs"])


class DumpArgsTests(unittest.TestCase):
    def test_the_proof_dump_args_are_the_real_per_tenant_dump_args(self) -> None:
        # Both sides are read live, so a change to either one turns this red.
        transport = _dial_in_transport().RemoteMysqldumpTransport(host="host", user="user", ssl_ca="ca.pem")
        self.assertEqual(list(sp.DUMP_ARGS), transport.dump_args(sp.BLOG))


class RunRefusalTests(unittest.TestCase):
    def test_an_ambient_docker_host_is_refused_without_asking_docker(self) -> None:
        reason = sp.refusal(["snapshot-proof-source-1", "snapshot-proof-replica-1"], "tcp://192.0.2.10:2376", _docker_must_not_be_asked)
        self.assertIsNotNone(reason)
        self.assertIn("DOCKER_HOST", reason)

    def test_a_container_without_the_proof_prefix_is_refused_without_asking_docker(self) -> None:
        reason = sp.refusal(["prod-source", "snapshot-proof-replica-1"], None, _docker_must_not_be_asked)
        self.assertIsNotNone(reason)
        self.assertIn("prod-source", reason)

    def test_a_non_local_context_is_refused(self) -> None:
        for context in ("remote-prod", ""):
            reason = sp.refusal(["snapshot-proof-source-1", "snapshot-proof-replica-1"], None, lambda context=context: context)
            self.assertIsNotNone(reason, context)

    def test_the_local_contexts_and_prefixed_names_are_not_refused(self) -> None:
        for context in sp.LOCAL_DOCKER_CONTEXTS:
            self.assertIsNone(sp.refusal(["snapshot-proof-source-1", "snapshot-proof-replica-1"], None, lambda context=context: context))


class PythonRunRefusalTests(unittest.TestCase):
    """`snapshot_probe.py run` itself, against a fake docker on PATH. Without
    the refusal the run would go on to read a password file that is absent
    here and exit 1, so exit 5 is what proves the refusal happens first."""

    def _run(self, *, source: str, replica: str, context: str, docker_host: str | None = None) -> tuple[subprocess.CompletedProcess, str]:
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp) / "docker"
            fake.write_text(_FAKE_DOCKER, encoding="utf-8")
            fake.chmod(0o755)
            log = pathlib.Path(tmp) / "calls.log"
            env = {key: value for key, value in os.environ.items() if key != "DOCKER_HOST"}
            env.update(
                PATH=f"{tmp}{os.pathsep}{os.environ.get('PATH', '')}",
                FAKE_DOCKER_LOG=str(log),
                FAKE_DOCKER_CONTEXT=context,
            )
            if docker_host is not None:
                env["DOCKER_HOST"] = docker_host
            command = [sys.executable, str(pathlib.Path(sp.__file__)), "run", "--source", source, "--replica", replica, "--workdir", tmp]
            result = subprocess.run(command, env=env, capture_output=True, text=True, check=False, timeout=120)
            calls = log.read_text(encoding="utf-8") if log.exists() else ""
            return result, calls

    def test_a_container_without_the_proof_prefix_is_refused_before_docker(self) -> None:
        result, calls = self._run(source="prod-source", replica="snapshot-proof-replica-1", context="desktop-linux")
        self.assertEqual(result.returncode, sp.EXIT_REFUSED, result.stderr)
        self.assertIn("snapshot-proof-", result.stderr)
        self.assertEqual(calls, "")

    def test_a_remote_context_is_refused_after_only_the_context_check(self) -> None:
        result, calls = self._run(source="snapshot-proof-source-1", replica="snapshot-proof-replica-1", context="remote-prod")
        self.assertEqual(result.returncode, sp.EXIT_REFUSED, result.stderr)
        self.assertIn("remote-prod", result.stderr)
        self.assertEqual(calls.strip(), "context show")

    def test_an_ambient_docker_host_is_refused_before_docker(self) -> None:
        result, calls = self._run(
            source="snapshot-proof-source-1", replica="snapshot-proof-replica-1", context="desktop-linux", docker_host="tcp://192.0.2.10:2376"
        )
        self.assertEqual(result.returncode, sp.EXIT_REFUSED, result.stderr)
        self.assertIn("DOCKER_HOST", result.stderr)
        self.assertEqual(calls, "")

    def test_the_local_context_with_proof_names_is_not_refused(self) -> None:
        result, calls = self._run(source="snapshot-proof-source-1", replica="snapshot-proof-replica-1", context="desktop-linux")
        self.assertNotEqual(result.returncode, sp.EXIT_REFUSED, result.stderr)
        self.assertEqual(calls.strip(), "context show")


class ShellAndGrantHygieneTests(unittest.TestCase):
    def test_the_shell_variable_does_not_shadow_docker_context(self) -> None:
        self.assertNotIn("DOCKER_CONTEXT", _PROOF_SCRIPT)
        self.assertIn("ACTIVE_CONTEXT", _PROOF_SCRIPT)

    def test_the_move_account_is_not_granted_event(self) -> None:
        # No run uses --events and no schema has an event: the grant is unused.
        self.assertNotRegex(inspect.getsource(sp.seed), r"\bEVENT\b")
        self.assertIn("SELECT, LOCK TABLES, SHOW VIEW, TRIGGER ON", inspect.getsource(sp.seed))


_OFFSET = 1000.0  # client clock minus server clock, in the fixtures below
_TRANSIT = 0.001


def _event(thread: int, text: str, *, client_start: float, wait: float, pre: float = _TRANSIT, schema: str = "") -> sp.ServerEvent:
    """A server event placed on the server clock from where the client saw it."""
    return sp.ServerEvent(thread, client_start - _OFFSET + pre, wait, schema, text)


def _writer_text(number: int, tag: str = "w1") -> str:
    return f"INSERT INTO posts (title) VALUES ('{tag}-{number}')"


class _Window:
    """330 fast `other` statements (the writer's own), one slow one at number
    101, and whatever else the case adds to the server's history."""

    SLOW_NUMBER = 101
    SLOW_SEND = 103.0
    SLOW_LATENCY = 0.3

    def __init__(self, *, inside: float = 0.298, pre: float = _TRANSIT, record: bool = True) -> None:
        self.samples = [(100.0 + 0.03 * n, 0.004) for n in range(330)]
        self.samples[self.SLOW_NUMBER - 1] = (self.SLOW_SEND, self.SLOW_LATENCY)
        self.events = [
            _event(1, _writer_text(n), client_start=send, wait=0.002, schema="other")
            for n, (send, latency) in enumerate(self.samples, 1)
            if n != self.SLOW_NUMBER
        ]
        if record:
            self.events.append(
                _event(1, _writer_text(self.SLOW_NUMBER), client_start=self.SLOW_SEND, wait=inside, pre=pre, schema="other")
            )
        self.events.append(_event(3, "SELECT SLEEP(10) FROM posts LIMIT 1", client_start=100.0, wait=10.0, schema="other"))
        self.holds: list[sp.Hold] = []

    @property
    def ack(self) -> float:
        return self.SLOW_SEND + self.SLOW_LATENCY

    def add(self, text: str, *, ends: float, wait: float = 0.01) -> None:
        """A snapshot-side statement from another thread that ends `ends`
        seconds after the slow statement's acknowledgement (negative: before)."""
        self.events.append(_event(2, text, client_start=self.ack + ends - wait, wait=wait))

    def report(self) -> sp.StallReport:
        return sp.stall_report(
            tag="w1",
            window_samples=sp.indexed_between(self.samples, 100.0, 110.0),
            began=100.0,
            baseline_worst=0.004,
            events=self.events,
            reader_sent=100.0,
            snapshot_intervals=[(102.0, 102.9), (102.95, 103.4)],
            holds=self.holds,
        )

    def worst(self) -> sp.SlowSample:
        return self.report().slow[0]


class StallReportTests(unittest.TestCase):
    def test_a_500_ms_hold_on_the_other_schema_is_red_and_names_control_2_and_the_lock(self) -> None:
        verdict, lines = sp.fixture_outcome(stalled=True)
        self.assertFalse(verdict.passed)
        self.assertIn("control 2", verdict.reason)
        self.assertIn("held lock on other.posts (injected hold, 500 ms)", verdict.reason)
        self.assertTrue(any("mechanism: held lock on other.posts" in line for line in lines), lines)

    def test_the_same_window_with_the_lock_released_is_green(self) -> None:
        verdict, _ = sp.fixture_outcome(stalled=False)
        self.assertTrue(verdict.passed, verdict.reason)
        self.assertNotIn("mechanism", verdict.reason)

    def test_the_limit_is_not_the_report(self) -> None:
        # The report names a mechanism for the slowest statements even when
        # all are under the limit; it never moves the gate.
        report = _Window(inside=0.002).report()
        self.assertGreater(report.client_worst, sp.WRITER_LIMIT_SECONDS)
        passing = sp.stall_report(
            tag="w1", window_samples=[(1, 100.0, 0.004), (2, 100.03, 0.02)], began=100.0, baseline_worst=0.004, events=[]
        )
        self.assertEqual(passing.over_limit, 0)
        self.assertEqual(len(passing.slow), 2)

    def test_a_stall_released_as_a_coordinate_read_ends_is_named_the_coordinate_read(self) -> None:
        window = _Window()
        window.add("SELECT LOCAL FROM performance_schema.log_status", ends=-0.003)
        slow = window.worst()
        self.assertEqual(slow.mechanism, sp.MECH_COORDINATE)
        self.assertEqual(slow.released_by[0], sp.EVENT_COORDINATE)
        self.assertAlmostEqual(slow.released_by[1], -0.003, places=4)
        self.assertAlmostEqual(slow.coordinate_gap, -0.003, places=4)

    def test_a_stall_released_as_the_unlock_ends_is_the_snapshot_lock_phase(self) -> None:
        window = _Window()
        window.add("UNLOCK TABLES", ends=0.004)
        self.assertEqual(window.worst().mechanism, sp.MECH_LOCK_PHASE)

    def test_a_stall_released_as_the_snapshot_opens_is_the_snapshot_lock_phase(self) -> None:
        window = _Window()
        window.add("START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */", ends=-0.002)
        self.assertEqual(window.worst().mechanism, sp.MECH_LOCK_PHASE)

    def test_a_stall_released_as_a_flush_ends_is_the_old_paths_lock_phase(self) -> None:
        window = _Window()
        window.add("FLUSH /*!40101 LOCAL */ TABLES", ends=-0.001)
        self.assertEqual(window.worst().mechanism, sp.MECH_LOCK_PHASE)

    def test_overlapping_a_coordinate_read_is_not_enough_to_blame_it(self) -> None:
        window = _Window()
        window.add("SELECT LOCAL FROM performance_schema.log_status", ends=-0.15)
        slow = window.worst()
        self.assertEqual(slow.mechanism, sp.MECH_IN_SERVER)
        self.assertIsNone(slow.released_by)
        self.assertIn((sp.EVENT_COORDINATE, 1), slow.overlapping)

    def test_a_stall_inside_the_server_with_nothing_of_the_snapshot_near_is_named_so(self) -> None:
        window = _Window()
        self.assertEqual(window.worst().mechanism, sp.MECH_IN_SERVER)

    def test_a_short_server_time_with_a_long_client_time_is_client_side(self) -> None:
        window = _Window(inside=0.004, pre=0.15)
        slow = window.worst()
        self.assertEqual(slow.mechanism, sp.MECH_CLIENT)
        # Pre-server is the excess over the usual transit (_TRANSIT).
        self.assertAlmostEqual(slow.pre, 0.15 - _TRANSIT, places=6)
        self.assertAlmostEqual(slow.inside, 0.004, places=6)
        self.assertAlmostEqual(slow.post, 0.3 - (0.15 - _TRANSIT) - 0.004, places=6)

    def test_a_statement_with_no_server_record_is_unattributed_never_skipped(self) -> None:
        window = _Window(record=False)
        report = window.report()
        self.assertEqual(report.slow[0].number, _Window.SLOW_NUMBER)
        self.assertEqual(report.slow[0].mechanism, sp.MECH_UNATTRIBUTED)
        self.assertIsNone(report.slow[0].inside)
        self.assertEqual(report.unattributed, 1)
        self.assertTrue(any("no server record" in line for line in report.lines()), report.lines())

    def test_with_no_server_history_at_all_every_slow_statement_is_unattributed(self) -> None:
        report = sp.stall_report(
            tag="w1",
            window_samples=[(1, 100.0, 0.004), (2, 100.03, 0.4)],
            began=100.0,
            baseline_worst=0.004,
            events=None,
            server_note="server-side history unavailable: x",
        )
        self.assertFalse(report.server_available)
        self.assertEqual(report.mechanism, sp.MECH_UNATTRIBUTED)
        self.assertIn("server-side history unavailable: x", report.lines()[0])

    def test_an_injected_hold_is_named_without_a_server_record(self) -> None:
        window = _Window(record=False)
        window.holds = [sp.Hold(103.0, 103.5, 500)]
        self.assertEqual(window.worst().mechanism, sp.MECH_HELD_LOCK.format(millis=500))

    def test_a_hold_that_did_not_overlap_the_statement_is_not_blamed(self) -> None:
        window = _Window()
        window.holds = [sp.Hold(105.0, 105.5, 500)]
        self.assertEqual(window.worst().mechanism, sp.MECH_IN_SERVER)

    def test_the_writer_and_the_reader_are_not_counted_as_overlapping_events(self) -> None:
        slow = _Window().worst()
        self.assertEqual(slow.overlapping, ())

    def test_the_snapshot_running_at_the_acknowledgement_is_numbered(self) -> None:
        slow = _Window().worst()
        self.assertEqual(slow.snapshot, 2)
        self.assertAlmostEqual(slow.offset, 3.0)
        self.assertEqual(sp.snapshot_at([(0.0, 1.0), (2.0, 3.0)], 1.5), None)
        self.assertEqual(sp.snapshot_at([(0.0, 1.0), (2.0, 3.0)], 2.5), 2)

    def test_the_server_side_figures_come_from_the_other_schemas_writer_inside_the_sleep_span(self) -> None:
        window = _Window(inside=0.298)
        # A statement of another schema, and one outside the long reader's
        # span, must not move the figures.
        window.events.append(_event(9, _writer_text(500, "w2"), client_start=105.0, wait=9.0, schema="blog"))
        window.events.append(_event(1, _writer_text(501), client_start=200.0, wait=7.0, schema="other"))
        report = window.report()
        self.assertAlmostEqual(report.server_worst, 0.298, places=6)
        self.assertAlmostEqual(report.inside_p50, 0.002, places=6)

    def test_the_latency_split_and_the_clock_offset_are_computed_not_assumed(self) -> None:
        report = _Window(inside=0.2, pre=0.05).report()
        self.assertAlmostEqual(report.offset, _OFFSET - _TRANSIT, places=6)
        self.assertEqual(report.offset_source, "329 fast samples")
        slow = report.slow[0]
        self.assertAlmostEqual(slow.pre, 0.05 - _TRANSIT, places=6)
        self.assertAlmostEqual(slow.inside, 0.2, places=6)
        self.assertAlmostEqual(slow.post, 0.05 + _TRANSIT, places=6)
        self.assertAlmostEqual(slow.pre + slow.inside + slow.post, slow.latency, places=6)

    def test_the_offset_rests_on_fast_samples_only(self) -> None:
        pairs = [(10.0, 0.0, 0.002), (11.0, 1.0, 0.003), (12.0, 2.0, 0.004), (13.0, 5.0, 0.5)]
        self.assertEqual(sp.clock_offset(pairs), (10.0, 3))
        self.assertIsNone(sp.clock_offset([(1.0, 0.0, 0.5)]))

    def test_with_too_few_fast_samples_the_offset_comes_from_the_sleep_anchor(self) -> None:
        events = [
            _event(1, _writer_text(1), client_start=100.0, wait=0.002, schema="other"),
            _event(3, "SELECT SLEEP(10) FROM posts LIMIT 1", client_start=99.0, wait=10.0, schema="other"),
        ]
        report = sp.stall_report(
            tag="w1", window_samples=[(1, 100.0, 0.002)], began=99.0, baseline_worst=0.0, events=events, reader_sent=99.0
        )
        self.assertEqual(report.offset_source, "the SLEEP anchor")
        self.assertAlmostEqual(report.offset, 99.0 - (99.0 - _OFFSET + _TRANSIT), places=6)

    def test_a_row_of_the_history_is_parsed_on_the_server_timer(self) -> None:
        rows = [
            "12\t5000000000000\t2500000000\tother\tINSERT INTO posts (title) VALUES ('w1-1')",
            "13\t6000000000000\t10000000000\t\tUNLOCK TABLES",
            "14\t7000000000000\t1000000000\tother\tNULL",
            "not a row",
            "15\tnope\t1\tother\tSELECT 1",
        ]
        events = sp.parse_history(rows)
        self.assertEqual([event.thread for event in events], [12, 13])
        self.assertAlmostEqual(events[0].start, 5.0)
        self.assertAlmostEqual(events[0].wait, 0.0025)
        self.assertAlmostEqual(events[0].end, 5.0025)
        self.assertEqual(events[1].schema, "")

    def test_each_statement_is_classified_by_its_text(self) -> None:
        expected = {
            "SELECT LOCAL FROM performance_schema.log_status": sp.EVENT_COORDINATE,
            "SHOW MASTER STATUS": sp.EVENT_COORDINATE,
            "LOCK TABLES `blog`.`posts` READ, `blog`.`users` READ": sp.EVENT_LOCK,
            "UNLOCK TABLES": sp.EVENT_LOCK,
            "START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */": sp.EVENT_OPEN,
            "FLUSH /*!40101 LOCAL */ TABLES": sp.EVENT_FLUSH,
            "SELECT /*!40001 SQL_NO_CACHE */ * FROM `posts`": sp.EVENT_DUMP,
            "SHOW CREATE TABLE `posts`": sp.EVENT_DUMP,
            "SET SESSION lock_wait_timeout = 1; SET SESSION wait_timeout = 2": sp.EVENT_DUMP,
            "SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE'": sp.EVENT_DUMP,
            "SELECT COUNT(*) FROM performance_schema.processlist": sp.EVENT_OTHER,
        }
        for text, label in expected.items():
            self.assertEqual(sp.classify_event(text), label, text)

    def test_the_verdict_names_only_the_closed_set_of_mechanisms(self) -> None:
        names = {
            sp.MECH_HELD_LOCK.format(millis=500),
            sp.MECH_COORDINATE,
            sp.MECH_LOCK_PHASE,
            sp.MECH_IN_SERVER,
            sp.MECH_CLIENT,
            sp.MECH_UNATTRIBUTED,
        }
        self.assertEqual(
            names,
            {
                "held lock on other.posts (injected hold, 500 ms)",
                "coordinate read",
                "snapshot lock phase",
                "in-server, no snapshot overlap",
                "pre- or post-server (client side)",
                "unattributed",
            },
        )
        seen = {
            sp.stall_mechanism(latency=0.3, inside=0.29, released_by=(label, 0.0), hold=None)
            for label in sp.SNAPSHOT_PHASES
        } | {
            sp.stall_mechanism(latency=0.3, inside=0.29, released_by=None, hold=None),
            sp.stall_mechanism(latency=0.3, inside=0.01, released_by=None, hold=None),
            sp.stall_mechanism(latency=0.3, inside=None, released_by=None, hold=None),
            sp.stall_mechanism(latency=0.3, inside=None, released_by=None, hold=sp.Hold(0.0, 0.5, 500)),
        }
        self.assertEqual(seen, names)

    def test_the_report_lines_carry_what_the_cause_rule_reads(self) -> None:
        window = _Window()
        window.add("SELECT LOCAL FROM performance_schema.log_status", ends=-0.003)
        text = "\n".join(window.report().lines())
        for needle in (
            "control 2 report: client worst 300.0 ms over",
            "baseline worst 4.0 ms",
            "in-server worst 298.0 ms",
            "p50 2.0 ms",
            "slow #1: statement 101 at +3.000 s",
            "pre-server 0.0 ms + in-server 298.0 ms + post-server 2.0 ms",
            "snapshot 2 running",
            "nearest coordinate read ended 3.0 ms before the ack",
            "released by coordinate read (ended 3.0 ms before the ack)",
            "mechanism: coordinate read",
        ):
            self.assertIn(needle, text)


class OtherLockSabotageTests(unittest.TestCase):
    class _Recorder:
        def __init__(self, fail_on_sleep: bool = False) -> None:
            self.sql: list[str] = []
            self.fail_on_sleep = fail_on_sleep

        def run(self, sql: str):
            self.sql.append(sql)
            return [], 0.0

    def test_the_hold_takes_a_real_read_lock_on_the_other_schemas_table_then_releases_it(self) -> None:
        session = self._Recorder()
        slept: list[float] = []
        ticks = iter([10.0, 10.5])
        hold = sp.hold_other_lock(session, clock=lambda: next(ticks), sleep=slept.append)
        self.assertEqual(session.sql, ["LOCK TABLES other.posts READ;", "UNLOCK TABLES;"])
        self.assertEqual(slept, [0.5])
        self.assertEqual(hold, sp.Hold(10.0, 10.5, 500))

    def test_the_lock_is_released_even_if_the_wait_is_interrupted(self) -> None:
        session = self._Recorder()

        def interrupted(_: float) -> None:
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            sp.hold_other_lock(session, sleep=interrupted)
        self.assertEqual(session.sql[-1], "UNLOCK TABLES;")

    def test_the_hold_is_long_enough_to_clear_the_limit_and_short_enough_to_end_mid_window(self) -> None:
        self.assertGreater(sp.INJECTED_HOLD_SECONDS, 4 * sp.WRITER_LIMIT_SECONDS)
        self.assertLess(sp.INJECTED_HOLD_DELAY_SECONDS + sp.INJECTED_HOLD_SECONDS, 10.0)

    def test_other_lock_turns_control_two_of_each_probe_red_and_no_other_control(self) -> None:
        self.assertEqual(sp.SABOTAGE_TARGETS["other-lock"], (2,))

    def test_the_scenario_runs_the_hold_only_under_the_sabotage(self) -> None:
        source = inspect.getsource(sp._long_reader_window)
        self.assertIn('ctx.sabotaged("other-lock")', source)
        self.assertIn("if inject:", source)


class OneScenarioTests(unittest.TestCase):
    def test_the_replication_probe_calls_the_shared_scenario_with_its_own_snapshot(self) -> None:
        import replication_client_probe as rcp

        source = inspect.getsource(rcp.other_tenant_phase)
        self.assertIn("sp.long_reader_scenario(", source)
        self.assertIn("take_snapshot(run,", source)
        self.assertIn("old_path_sequence(run)", source)
        self.assertIn("sp.control_2_outcome(", source)
        # No second copy of the scenario or of the verdict.
        self.assertNotIn('reader.run("SELECT SLEEP', source)
        self.assertNotIn("writer_stall_verdict", source)
        self.assertNotIn("sp.Writer", source)

    def test_the_replication_probe_keeps_its_own_take_snapshot(self) -> None:
        import replication_client_probe as rcp

        self.assertIsNot(rcp.take_snapshot, sp.take_snapshot)
        self.assertIn("COORDINATES_MASTER_STATUS", inspect.getsource(rcp.take_snapshot))
        self.assertNotIn("COORDINATES_MASTER_STATUS", inspect.getsource(sp.take_snapshot))

    def test_there_is_one_verdict_function_for_control_two(self) -> None:
        import replication_client_probe as rcp

        self.assertEqual(inspect.getsource(rcp).count("writer_stall_verdict"), 0)
        self.assertEqual(inspect.getsource(sp).count("def writer_stall_verdict"), 1)


class _FakeDurableSource:
    """A source that keeps the two durability settings and answers the probe's
    read and SET GLOBAL, no Docker. `fail_set_after` makes the Nth SET raise
    after applying its first assignment, as a failure part-way would."""

    name = "fake-source"

    def __init__(self, sync_binlog: str = "1", flush: str = "1") -> None:
        self.values = {"sync_binlog": sync_binlog, "innodb_flush_log_at_trx_commit": flush}
        self.history: list[tuple[str, str]] = []
        self.sets = 0
        self.fail_set_number: int | None = None
        self.refuse_to_apply = False

    def query(self, sql: str, **_: object) -> list[list[str]]:
        assert "@@GLOBAL.sync_binlog" in sql, sql
        return [[self.values["sync_binlog"], self.values["innodb_flush_log_at_trx_commit"]]]

    def run(self, sql: str, **_: object):
        match = re.fullmatch(r"SET GLOBAL (.+);", sql)
        assert match, sql
        self.sets += 1
        if self.refuse_to_apply:
            return None
        for index, part in enumerate(match.group(1).split(", ")):
            name, value = part.split("=")
            if self.fail_set_number == self.sets and index == 1:
                raise sp.ProofError("SET GLOBAL failed part-way")
            self.values[name] = value
            self.history.append((name, value))
        return None


class RelaxedDurabilityTests(unittest.TestCase):
    REAL = {"sync_binlog": "1", "innodb_flush_log_at_trx_commit": "1"}
    RELAXED = {"sync_binlog": "0", "innodb_flush_log_at_trx_commit": "2"}

    def test_the_window_runs_with_fsync_relaxed_and_the_real_settings_come_back(self) -> None:
        source = _FakeDurableSource()
        with sp.relaxed_durability(source) as line:
            self.assertEqual(source.values, self.RELAXED)
        self.assertEqual(source.values, self.REAL)
        self.assertIn("this window only", line)
        self.assertIn("sync_binlog=0", line)
        self.assertIn("were sync_binlog=1", line)

    def test_what_comes_back_is_what_was_there_not_a_hard_coded_default(self) -> None:
        source = _FakeDurableSource(sync_binlog="100", flush="0")
        with sp.relaxed_durability(source):
            pass
        self.assertEqual(source.values, {"sync_binlog": "100", "innodb_flush_log_at_trx_commit": "0"})

    def test_the_restore_runs_when_the_window_fails(self) -> None:
        source = _FakeDurableSource()
        with self.assertRaises(sp.ProofError):
            with sp.relaxed_durability(source):
                self.assertEqual(source.values, self.RELAXED)
                raise sp.ProofError("control 2 window failed")
        self.assertEqual(source.values, self.REAL)

    def test_the_restore_runs_on_an_interrupt(self) -> None:
        source = _FakeDurableSource()
        with self.assertRaises(KeyboardInterrupt):
            with sp.relaxed_durability(source):
                raise KeyboardInterrupt
        self.assertEqual(source.values, self.REAL)

    def test_the_restore_runs_when_relaxing_itself_fails_part_way(self) -> None:
        source = _FakeDurableSource()
        source.fail_set_number = 1
        with self.assertRaises(sp.ProofError):
            with sp.relaxed_durability(source):
                self.fail("the body must not run when the settings could not be relaxed")
        self.assertEqual(source.values, self.REAL)

    def test_a_setting_that_did_not_take_is_an_error_not_a_quiet_pass(self) -> None:
        source = _FakeDurableSource()
        source.refuse_to_apply = True
        with self.assertRaises(sp.ProofError) as caught:
            with sp.relaxed_durability(source):
                self.fail("the body must not run under settings that were not applied")
        self.assertIn("durability not relaxed", str(caught.exception))

    def test_the_scenario_restores_on_every_exit_including_the_failing_one(self) -> None:
        import unittest.mock as mock

        source = _FakeDurableSource()
        ctx = mock.Mock(source=source)
        seen: list[dict[str, str]] = []

        def fails(*_: object) -> None:
            seen.append(dict(source.values))
            raise sp.ProofError("the long reader never started")

        with mock.patch.object(sp, "_long_reader_window", side_effect=fails):
            with self.assertRaises(sp.ProofError):
                sp.long_reader_scenario(ctx, mock.Mock())
        self.assertEqual(seen, [self.RELAXED])
        self.assertEqual(source.values, self.REAL)

    def test_the_scenario_reports_what_it_ran_under(self) -> None:
        import unittest.mock as mock

        source = _FakeDurableSource()
        ran = sp.LongReaderRun([(100.0, 0.004)], (100.0, 110.0), 0.004, 1, tag="w1")
        with mock.patch.object(sp, "_long_reader_window", return_value=ran):
            run = sp.long_reader_scenario(mock.Mock(source=source), mock.Mock())
        self.assertIn("commit durability relaxed for this window only", run.durability)
        _, lines = sp.control_2_outcome(run, old_path=False)
        self.assertIn(run.durability, lines)
        self.assertEqual(source.values, self.REAL)

    def test_sabotage_runs_are_inside_the_relaxed_window_and_so_restored_too(self) -> None:
        # The old-path and other-lock branches live in _long_reader_window,
        # the only thing the wrapper runs.
        wrapper = inspect.getsource(sp.long_reader_scenario)
        window = inspect.getsource(sp._long_reader_window)
        self.assertIn("with relaxed_durability(ctx.source)", wrapper)
        self.assertIn("_long_reader_window(ctx, actions)", wrapper)
        self.assertIn('ctx.sabotaged("old-path")', window)
        self.assertIn('ctx.sabotaged("other-lock")', window)

    def test_one_home_for_the_setting_and_only_control_two_uses_it(self) -> None:
        import replication_client_probe as rcp

        self.assertEqual(inspect.getsource(sp).count("def relaxed_durability"), 1)
        self.assertNotIn("sync_binlog", inspect.getsource(rcp))
        self.assertNotIn("relaxed_durability", inspect.getsource(rcp))
        # The replication probe's control 2 reaches it through the shared scenario.
        self.assertIn("sp.long_reader_scenario(", inspect.getsource(rcp.other_tenant_phase))
        for number in (1, 3, 4, 5):
            for module in (sp, rcp):
                function = getattr(module, f"control_{number}", None)
                if function is not None:
                    text = inspect.getsource(function)
                    self.assertNotIn("relaxed_durability", text)
                    self.assertNotIn("sync_binlog", text)

    def test_the_gate_is_unchanged_by_the_relaxation(self) -> None:
        self.assertEqual(sp.WRITER_LIMIT_SECONDS, 0.1)
        stalled, lines = sp.fixture_outcome(stalled=True)
        self.assertFalse(stalled.passed)
        self.assertIn("control 2", stalled.reason)
        self.assertTrue(sp.fixture_outcome(stalled=False)[0].passed)


class DiagnosticKnobsAreGoneTests(unittest.TestCase):
    # The names are split so this file does not contain them itself.
    KNOBS = ("PROBE_" + "DIAG", "PROOF_DATA_" + "ROOT")

    def test_no_diagnostic_knob_is_read_anywhere_in_the_proofs_or_their_workflows(self) -> None:
        roots = [_REPO_ROOT / "db" / "provision", _REPO_ROOT / ".github" / "workflows"]
        offenders = []
        for root in roots:
            for path in sorted(root.iterdir()):
                if path.is_file() and path.suffix in {".py", ".sh", ".md", ".yml"} and path.name != pathlib.Path(__file__).name:
                    text = path.read_text(encoding="utf-8")
                    offenders += [f"{path.name}: {knob}" for knob in self.KNOBS if knob in text]
        self.assertEqual(offenders, [])

    def test_the_temporary_diagnostic_workflow_is_deleted(self) -> None:
        # Red on the soak head, where the matrix still has to run, and green on
        # the final head: the diagnosis is not a permanent soak.
        self.assertFalse((_REPO_ROOT / ".github" / "workflows" / "snapshot-proof-diagnostic.yml").exists())

    def test_the_diagnostic_variants_and_their_helpers_are_not_in_the_probe(self) -> None:
        for name in ("DIAGNOSTIC_VARIANTS", "diagnostic_variants", "constant_coordinates", "CONSTANT_COORDINATE_SQL", "plain_dump", "EVENT_STUB"):
            self.assertFalse(hasattr(sp, name), name)


class HistorySizingTests(unittest.TestCase):
    def test_the_source_alone_gets_the_history_size_and_the_cnf_is_untouched(self) -> None:
        self.assertIn('start_server "$SRC" --performance-schema-events-statements-history-long-size=100000', _PROOF_SCRIPT)
        self.assertNotIn("history-long-size", _PROOF_SCRIPT.split('start_server "$REP"')[1].splitlines()[0])
        cnf = (_REPO_ROOT / "db" / "stack" / "conf.d" / "branchleft.cnf").read_text(encoding="utf-8")
        self.assertNotIn("history_long", cnf.replace("-", "_"))

    def test_the_history_query_reads_only_the_instrument_table_and_is_not_timed_with_the_window(self) -> None:
        self.assertIn("performance_schema.events_statements_history_long", sp.HISTORY_SQL)
        source = inspect.getsource(sp._long_reader_window)
        # Read once, after the writer has stopped, outside the try block.
        self.assertGreater(source.index("read_history(ctx)"), source.index("samples = writer.finish()"))


class SelfTestCliTests(unittest.TestCase):
    def test_the_self_test_flag_runs_the_canned_cases(self) -> None:
        result = subprocess.run(
            [os.environ.get("PYTHON", "python3"), str(pathlib.Path(sp.__file__)), "--self-test"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("cases behaved", result.stdout)


if __name__ == "__main__":
    unittest.main()
