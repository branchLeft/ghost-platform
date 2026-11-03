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
            set(by_verdict), {"writer_stall", "checksum", "global_lock", "scoped_grant", "bounded_wait", "retry"}
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
