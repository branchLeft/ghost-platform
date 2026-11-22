"""Tests for the magic-link gate's runner, magic_link_gate.py.

Run: python3 -m unittest discover -s csp/gate -p 'test_magic_link_gate.py' -v
No Docker, no browser, no network: every program the gate starts is a recording
fake. The last class mutates the real source and requires these same tests to go red.
"""

from __future__ import annotations

import importlib.util
import io
import re
import sys
import tempfile
import unittest
from collections.abc import Callable, Sequence
from pathlib import Path
from types import ModuleType

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # the gate imports magic_link_verdict from its own directory
SOURCE = HERE / "magic_link_gate.py"
PID = 4242
SPOOL_KEY = "SPOOLKEY" + "Z" * 16
DRAIN_TOKEN = "KEY000000000000000000001"
POLICY = (
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'sha256-AAAA'; frame-ancestors 'self'"
)
WIDGETS = (
    "portal__url=http://localhost:4331/bl-assets/portal.min.js\n"
    "sodoSearch__url=http://localhost:4331/bl-assets/sodo-search.min.js\n"
)


def load(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


REAL = load(SOURCE, "magic_link_gate_real")


class Harness:
    """The gate wired to fakes: records every command, answers like the real tools."""

    def __init__(
        self,
        gate: ModuleType,
        environ: dict[str, str] | None = None,
        answers: Sequence[Callable[[object], object]] = (),
        built: bool = True,
        policy: str = POLICY,
    ) -> None:
        self.gate = gate
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        if built:
            dist = self.root / "render-core" / "dist"
            dist.mkdir(parents=True)
            (dist / "index.js").write_text("")
        self.answers = list(answers)
        self.policy = policy
        self.calls: list[object] = []
        self.clock = 1000
        self.out = io.StringIO()
        self.err = io.StringIO()
        self.deps = gate.Deps(
            repo_root=self.root,
            environ=dict(environ or {}),
            run=self.run_command,
            now=lambda: self.clock,
            sleep=self.sleep,
            pid=PID,
            token=lambda: DRAIN_TOKEN,
            out=self.out,
            err=self.err,
        )

    def close(self) -> None:
        self.tmp.cleanup()

    def sleep(self, seconds: float) -> None:
        self.clock += int(seconds)

    def run_command(self, command: object) -> object:
        self.calls.append(command)
        for answer in self.answers:
            result = answer(command)
            if result is not None:
                return result
        return self.default_answer(command)

    def default_answer(self, command: object) -> object:
        result = self.gate.Result
        argv = command.argv
        if argv[:2] == ("docker", "exec") and "register" in argv:
            return result(0, f"registered the sender domain\n{SPOOL_KEY}\n")
        if argv[0] == "node":
            script = Path(argv[1]).name
            if script == "setup-content.mjs":
                return result(0, "POST_SLUG=post\nTAG_SLUG=tag\nAUTHOR_SLUG=author\nSESSION_COOKIE=\"c=1\"\n")
            if script == "derive-script-hashes.mjs":
                return result(0, '{"kind":"computed","hashes":["sha256-AAAA"]}\n')
            if script == "render-header.mjs":
                return result(0, f"enforcing\t{self.policy}\n")
            if script == "render-widgets.ts":
                return result(0, WIDGETS)
            if script == "capture-magic-link.ts":
                self.clock += 9
                return result(0, '{"label":"' + command.env["PROOF_LABEL"] + '"}\n\n')
        return result(0)

    def go(self, *args: str) -> int:
        return int(self.gate.main(list(args), self.deps))

    def commands(self, *prefix: str) -> list[object]:
        return [c for c in self.calls if c.argv[: len(prefix)] == prefix]

    def node(self, script: str) -> object:
        (found,) = [c for c in self.calls if c.argv[0] == "node" and c.argv[1].endswith(script)]
        return found

    def ghost_run(self) -> object:
        (found,) = [c for c in self.commands("docker", "run") if f"csp-magic-link-ghost-{PID}" in c.argv]
        return found

    def origin_runs(self) -> list[object]:
        return [c for c in self.commands("docker", "run") if f"csp-magic-link-origin-{PID}" in c.argv]


def setting(command: object, key: str) -> str | None:
    """The value of `-e key=value` in a docker run command, if present."""
    argv = command.argv
    for index, word in enumerate(argv[:-1]):
        if word == "-e" and argv[index + 1].startswith(f"{key}="):
            return str(argv[index + 1]).partition("=")[2]
    return None


class GateTests:
    """The gate's behaviour. `gate` is the module under test (real or mutated)."""

    gate: ModuleType

    def harness(self, **kwargs: object) -> Harness:
        harness = Harness(self.gate, **kwargs)
        self.addCleanup(harness.close)
        return harness

    def failing_node(self, script: str, code: int) -> Callable[[object], object]:
        def answer(command: object) -> object:
            if command.argv[0] == "node" and command.argv[1].endswith(script):
                return self.gate.Result(code)
            return None

        return answer

    def verdict_exits(self, code: int) -> Callable[[object], object]:
        def answer(command: object) -> object:
            if command.argv[1:2] and command.argv[1].endswith("magic_link_verdict.py"):
                return self.gate.Result(code)
            return None

        return answer

    # --- the command line ----------------------------------------------------

    def test_the_sabotage_modes_and_image_are_read(self) -> None:
        options = self.gate.parse_args(["--sabotage=portal-on-cdn", "ghost:1"])
        self.assertEqual((options.sabotage, options.image), ("portal-on-cdn", "ghost:1"))
        self.assertEqual(self.gate.parse_args([]).sabotage, "")

    def test_an_unknown_sabotage_exits_two_naming_it_and_runs_nothing(self) -> None:
        for arg in ("--sabotage=bogus", "--sabotage="):
            with self.subTest(arg=arg):
                harness = self.harness()
                self.assertEqual(harness.go(arg), 2)
                self.assertIn(f"unknown sabotage: {arg}", harness.err.getvalue())
                self.assertEqual(harness.calls, [])

    def test_help_prints_the_usage_and_runs_nothing(self) -> None:
        harness = self.harness()
        self.assertEqual(harness.go("--help"), 0)
        self.assertIn("magic_link_gate.py [--sabotage=MODE]", harness.out.getvalue())
        self.assertEqual(harness.calls, [])

    def test_an_unbuilt_render_core_is_refused_before_anything_starts(self) -> None:
        harness = self.harness(built=False)
        self.assertEqual(harness.go(), 2)
        self.assertIn("render-core is not built", harness.err.getvalue())
        self.assertEqual(harness.calls, [])

    # --- a green run ----------------------------------------------------------

    def test_a_clean_run_exits_with_the_verdicts_code(self) -> None:
        for code in (0, 1):
            with self.subTest(code=code):
                harness = self.harness(answers=[self.verdict_exits(code)])
                self.assertEqual(harness.go("ghost:1"), code)
                self.assertIn(f"exit={code}", harness.out.getvalue())

    def test_the_verdict_judges_the_capture_against_the_tenants_origin(self) -> None:
        harness = self.harness()
        harness.go("ghost:1")
        (verdict,) = [c for c in harness.calls if c.argv[-2:-1] and c.argv[-2].endswith("magic_link_verdict.py")]
        self.assertEqual(verdict.argv[-1], "http://localhost:4331")
        self.assertIn('"label":"magic-link"', verdict.stdin)

    def test_the_policy_under_test_is_the_one_render_core_rendered_and_enforcing(self) -> None:
        harness = self.harness()
        harness.go("ghost:1")
        marker, enforcing = harness.origin_runs()
        self.assertIn("CSP_HEADER_NAME=X-Csp-Gate-Marker", marker.argv)
        self.assertIn("CSP_HEADER_NAME=Content-Security-Policy", enforcing.argv)
        self.assertIn(f"CSP_HEADER_VALUE={POLICY}", enforcing.argv)

    def test_a_policy_that_is_not_enforcing_is_refused_before_the_browser_starts(self) -> None:
        def report_only(command: object) -> object:
            if command.argv[0] == "node" and command.argv[1].endswith("render-header.mjs"):
                return self.gate.Result(0, "report-only\tdefault-src 'self'\n")
            return None

        harness = self.harness(answers=[report_only])
        self.assertEqual(harness.go("ghost:1"), 2)
        self.assertIn("not enforcing", harness.err.getvalue())
        self.assertEqual([c for c in harness.calls if c.argv[0] == "node" and c.argv[1].endswith("capture-magic-link.ts")], [])

    def test_the_images_are_built_unless_one_is_named(self) -> None:
        harness = self.harness()
        harness.go()
        tags = [c.argv[c.argv.index("-t") + 1] for c in harness.commands("docker", "build")]
        self.assertIn("csp-magic-link-ghost:local", tags)
        self.assertIn("csp-magic-link-spool:local", tags)
        named = self.harness()
        named.go("ghost:1")
        named_tags = [c.argv[c.argv.index("-t") + 1] for c in named.commands("docker", "build")]
        self.assertNotIn("csp-magic-link-ghost:local", named_tags)
        self.assertEqual(named.ghost_run().argv[-1], "ghost:1")

    # --- the disposable tenant -------------------------------------------------

    def test_the_network_has_the_spools_fixed_subnet_and_the_spool_its_address(self) -> None:
        harness = self.harness()
        harness.go("ghost:1")
        (network,) = harness.commands("docker", "network", "create")
        self.assertEqual(network.argv[3:5], ("--subnet", "10.231.203.0/28"))
        (spool,) = [c for c in harness.commands("docker", "run") if f"csp-magic-link-spool-{PID}" in c.argv]
        self.assertIn("10.231.203.2", spool.argv)
        self.assertIn("SHIM_DRAIN_HOST=10.231.203.2", spool.argv)
        self.assertIn("mail-spool", spool.argv)
        self.assertIn(f"SHIM_DRAIN_TOKEN={DRAIN_TOKEN}", spool.argv)

    def test_the_spools_drain_is_published_on_loopback_only(self) -> None:
        harness = self.harness(environ={"CSP_MAGIC_LINK_DRAIN_PORT": "5555"})
        harness.go("ghost:1")
        (spool,) = [c for c in harness.commands("docker", "run") if f"csp-magic-link-spool-{PID}" in c.argv]
        self.assertIn("127.0.0.1:5555:8081", spool.argv)
        capture = harness.node("capture-magic-link.ts")
        self.assertEqual(capture.env["PROOF_DRAIN_URL"], "http://127.0.0.1:5555")
        self.assertEqual(capture.env["PROOF_DRAIN_TOKEN"], DRAIN_TOKEN)

    def test_a_named_spool_image_is_used_and_not_built(self) -> None:
        harness = self.harness(environ={"CSP_MAGIC_LINK_SPOOL_IMAGE": "spool:pinned"})
        harness.go("ghost:1")
        (spool,) = [c for c in harness.commands("docker", "run") if f"csp-magic-link-spool-{PID}" in c.argv]
        self.assertEqual(spool.argv[-1], "spool:pinned")
        self.assertEqual([c for c in harness.commands("docker", "build") if "scripts/mail-gate/spool-standin" in c.argv], [])

    def test_ghost_sends_mail_to_the_spool_and_the_key_is_in_no_argument(self) -> None:
        harness = self.harness()
        harness.go("ghost:1")
        ghost = harness.ghost_run()
        self.assertEqual(setting(ghost, "mail__transport"), "SMTP")
        self.assertEqual(setting(ghost, "mail__options__host"), "mail-spool")
        self.assertEqual(setting(ghost, "mail__options__port"), "2525")
        self.assertEqual(setting(ghost, "mail__from"), "noreply@magic-link.csp-gate.test")
        self.assertEqual(setting(ghost, "mail__options__auth__user"), "magic-link.csp-gate.test")
        self.assertIn("mail__options__auth__pass", ghost.argv)  # by name
        self.assertEqual(ghost.env["mail__options__auth__pass"], SPOOL_KEY)
        for command in harness.calls:
            self.assertNotIn(SPOOL_KEY, " ".join(command.argv), command.argv)
        self.assertNotIn(SPOOL_KEY, harness.out.getvalue() + harness.err.getvalue())

    def test_no_mail_leaves_the_docker_network(self) -> None:
        harness = self.harness()
        harness.go("ghost:1")
        ghost = harness.ghost_run()
        for key in ("bulkEmail__mailgun__baseUrl", "bulkEmail__mailgun__apiKey"):
            self.assertIsNone(setting(ghost, key))
        self.assertIsNone(re.search(r"mailgun\.(net|org)|smtp\.", " ".join(ghost.argv)))

    def test_ghost_takes_its_widget_addresses_from_render_cores_own_table(self) -> None:
        harness = self.harness()
        harness.go("ghost:1")
        self.assertEqual(harness.node("render-widgets.ts").env["PROOF_ORIGIN"], "http://localhost:4331")
        ghost = harness.ghost_run()
        self.assertEqual(setting(ghost, "portal__url"), "http://localhost:4331/bl-assets/portal.min.js")
        self.assertEqual(setting(ghost, "sodoSearch__url"), "http://localhost:4331/bl-assets/sodo-search.min.js")

    def test_a_port_override_moves_the_tenants_origin_everywhere(self) -> None:
        harness = self.harness(environ={"CSP_MAGIC_LINK_PORT": "6000"})
        harness.go("ghost:1")
        self.assertEqual(setting(harness.ghost_run(), "url"), "http://localhost:6000")
        self.assertEqual(harness.node("capture-magic-link.ts").env["PROOF_ORIGIN"], "http://localhost:6000")
        self.assertIn("6000:8080", harness.origin_runs()[0].argv)

    def test_a_spool_that_registers_no_key_is_refused_and_cleaned_up(self) -> None:
        def no_key(command: object) -> object:
            if command.argv[:2] == ("docker", "exec"):
                return self.gate.Result(0, "")
            return None

        harness = self.harness(answers=[no_key])
        self.assertEqual(harness.go("ghost:1"), 2)
        self.assertIn("registered no key", harness.err.getvalue())
        self.assertEqual([c for c in harness.commands("docker", "run") if f"csp-magic-link-ghost-{PID}" in c.argv], [])

    # --- the sabotages ----------------------------------------------------------

    def enforcing_policy_served(self, harness: Harness) -> str:
        value = setting(harness.origin_runs()[-1], "CSP_HEADER_VALUE")
        assert value is not None
        return value

    def test_a_clean_run_serves_the_rendered_policy_unchanged(self) -> None:
        harness = self.harness()
        harness.go("ghost:1")
        self.assertEqual(self.enforcing_policy_served(harness), POLICY)

    def test_no_inline_style_takes_unsafe_inline_out_of_style_src_only(self) -> None:
        harness = self.harness()
        harness.go("--sabotage=no-inline-style", "ghost:1")
        served = self.enforcing_policy_served(harness)
        self.assertIn("style-src 'self';", served)
        self.assertNotIn("'unsafe-inline'", served)
        self.assertIn("script-src 'self' 'sha256-AAAA'", served)
        self.assertEqual(harness.node("capture-magic-link.ts").env["PROOF_LABEL"], "magic-link-no-inline-style")

    def test_no_self_script_takes_self_out_of_script_src_only(self) -> None:
        harness = self.harness()
        harness.go("--sabotage=no-self-script", "ghost:1")
        served = self.enforcing_policy_served(harness)
        self.assertIn("script-src 'sha256-AAAA'", served)
        self.assertIn("style-src 'self' 'unsafe-inline'", served)
        self.assertIn("default-src 'self'", served)

    def test_portal_on_cdn_leaves_ghost_its_own_widget_addresses_and_the_policy_alone(self) -> None:
        harness = self.harness()
        harness.go("--sabotage=portal-on-cdn", "ghost:1")
        ghost = harness.ghost_run()
        self.assertIsNone(setting(ghost, "portal__url"))
        self.assertEqual([c for c in harness.calls if c.argv[0] == "node" and c.argv[1].endswith("render-widgets.ts")], [])
        self.assertEqual(self.enforcing_policy_served(harness), POLICY)

    def test_a_sabotage_with_nothing_to_remove_is_refused_not_passed(self) -> None:
        for mode, policy in (
            ("no-inline-style", "default-src 'self'; style-src 'self'; script-src 'self'"),
            ("no-self-script", "default-src 'self'; script-src 'sha256-AAAA'"),
        ):
            with self.subTest(mode=mode):
                harness = self.harness(policy=policy)
                self.assertEqual(harness.go(f"--sabotage={mode}", "ghost:1"), 2)
                self.assertIn("found nothing to remove", harness.err.getvalue())
                self.assertEqual([c for c in harness.calls if c.argv[0] == "node" and c.argv[1].endswith("capture-magic-link.ts")], [])

    # --- failure and cleanup ------------------------------------------------------

    def test_a_failed_setup_step_ends_the_run_with_its_exit_code(self) -> None:
        harness = self.harness(answers=[self.failing_node("capture-magic-link.ts", 3)])
        self.assertEqual(harness.go("ghost:1"), 3)

    def test_cleanup_removes_every_container_and_the_network_on_every_ending(self) -> None:
        endings = {
            "green": [],
            "red": [self.verdict_exits(1)],
            "setup failed": [self.failing_node("derive-script-hashes.mjs", 5)],
        }
        for name, answers in endings.items():
            with self.subTest(ending=name):
                harness = self.harness(answers=answers)
                harness.go("ghost:1")
                removals = harness.commands("docker", "rm", "-fv")[-1]
                for kind in ("ghost", "origin", "spool"):
                    self.assertIn(f"csp-magic-link-{kind}-{PID}", removals.argv)
                self.assertEqual(
                    harness.commands("docker", "network", "rm")[-1].argv[-1], f"csp-magic-link-net-{PID}"
                )

    def test_a_refusal_before_anything_starts_removes_nothing(self) -> None:
        harness = self.harness(built=False)
        harness.go()
        self.assertEqual(harness.commands("docker"), [])


class Behaviour(GateTests, unittest.TestCase):
    gate = REAL


# (name, text to replace in the real source, replacement, a test that must go red)
MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        "refusal exit code 2 -> 1",
        "EXIT_REFUSED = 2",
        "EXIT_REFUSED = 1",
        "test_an_unknown_sabotage_exits_two_naming_it_and_runs_nothing",
    ),
    (
        "unbuilt render-core not refused",
        'if not (self.deps.repo_root / "render-core" / "dist" / "index.js").is_file():',
        "if False:",
        "test_an_unbuilt_render_core_is_refused_before_anything_starts",
    ),
    (
        "enforcing check skipped",
        'if cut_field(rendered, 1) != "enforcing":',
        "if False:",
        "test_a_policy_that_is_not_enforcing_is_refused_before_the_browser_starts",
    ),
    (
        "the verdict's code dropped",
        "return self.deps.run(verdict).returncode",
        "self.deps.run(verdict)\n        return 0",
        "test_a_clean_run_exits_with_the_verdicts_code",
    ),
    (
        "the policy served is not the rendered one",
        "self.start_origin(ENFORCING_HEADER, policy)",
        'self.start_origin(ENFORCING_HEADER, "default-src *")',
        "test_the_policy_under_test_is_the_one_render_core_rendered_and_enforcing",
    ),
    (
        "the spool key in an argument",
        '*("-e", "mail__options__auth__pass"),',
        '*("-e", f"mail__options__auth__pass={spool_key}"),',
        "test_ghost_sends_mail_to_the_spool_and_the_key_is_in_no_argument",
    ),
    (
        "mail aimed off the network",
        "f\"mail__options__host={SPOOL_ALIAS}\",",
        'f"mail__options__host=smtp.example.test",',
        "test_ghost_sends_mail_to_the_spool_and_the_key_is_in_no_argument",
    ),
    (
        "the drain published on every interface",
        'f"127.0.0.1:{self.drain_port}:8081"',
        'f"{self.drain_port}:8081"',
        "test_the_spools_drain_is_published_on_loopback_only",
    ),
    (
        "no fixed subnet",
        '"network", "create", "--subnet", SPOOL_SUBNET, self.net',
        '"network", "create", self.net',
        "test_the_network_has_the_spools_fixed_subnet_and_the_spool_its_address",
    ),
    (
        "widget addresses not taken from render-core",
        'rendered = self.check(self.node("proof/render-widgets.ts", {"PROOF_ORIGIN": self.origin}))\n        return [line for line in rendered.stdout.splitlines() if "=" in line]',
        "return []",
        "test_ghost_takes_its_widget_addresses_from_render_cores_own_table",
    ),
    (
        "portal-on-cdn still sets the widget addresses",
        "if self.options.sabotage == SABOTAGE_PORTAL_ON_CDN:",
        "if False:",
        "test_portal_on_cdn_leaves_ghost_its_own_widget_addresses_and_the_policy_alone",
    ),
    (
        "no-inline-style removes nothing",
        r"""broken = re.sub(r"(style-src[^;]*?)\s*'unsafe-inline'", r"\1", policy)""",
        "broken = policy",
        "test_no_inline_style_takes_unsafe_inline_out_of_style_src_only",
    ),
    (
        "no-self-script removes style's source as well",
        r"""broken = re.sub(r"(script-src)\s+'self'", r"\1", policy)""",
        r"""broken = policy.replace(" 'self'", "")""",
        "test_no_self_script_takes_self_out_of_script_src_only",
    ),
    (
        "a sabotage that changed nothing passes",
        "if broken == policy and mode in (SABOTAGE_NO_INLINE_STYLE, SABOTAGE_NO_SELF_SCRIPT):",
        "if False:",
        "test_a_sabotage_with_nothing_to_remove_is_refused_not_passed",
    ),
    (
        "cleanup skipped",
        "        finally:\n            self.cleanup()",
        "        finally:\n            pass",
        "test_cleanup_removes_every_container_and_the_network_on_every_ending",
    ),
    (
        "a missing spool key tolerated",
        "        if not key:\n",
        "        if False:\n",
        "test_a_spool_that_registers_no_key_is_refused_and_cleaned_up",
    ),
    (
        "a failed step's exit code lost",
        "            raise GateError(result.returncode)\n        return result",
        "            raise GateError(1)\n        return result",
        "test_a_failed_setup_step_ends_the_run_with_its_exit_code",
    ),
]


class SabotageProof(unittest.TestCase):
    """Break the real source one rule at a time: the tests above must go red."""

    def mutated(self, old: str, new: str) -> ModuleType:
        source = SOURCE.read_text()
        self.assertIn(old, source, "sabotage target not found: a mutation that changed nothing proves nothing")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "mutated_gate.py"
        path.write_text(source.replace(old, new, 1))
        return load(path, f"magic_link_gate_mutated_{abs(hash(old))}")

    def failing_tests(self, module: ModuleType) -> list[str]:
        suite_class = type("MutatedBehaviour", (GateTests, unittest.TestCase), {"gate": module})
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(suite_class)
        result = unittest.TextTestRunner(stream=io.StringIO()).run(suite)
        return [str(case) for case, _ in result.failures + result.errors]

    def test_each_mutation_turns_the_named_test_red(self) -> None:
        for name, old, new, expected in MUTATIONS:
            with self.subTest(mutation=name):
                failed = self.failing_tests(self.mutated(old, new))
                self.assertTrue(
                    any(expected in test for test in failed),
                    f"{name}: expected {expected} to fail, failing: {failed}",
                )

    def test_the_unmutated_source_is_green(self) -> None:
        self.assertEqual(self.failing_tests(REAL), [])


if __name__ == "__main__":
    unittest.main()
