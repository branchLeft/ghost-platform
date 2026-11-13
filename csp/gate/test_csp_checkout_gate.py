"""Tests for the checkout gate's runner, csp-checkout-gate.py.

Run: python3 -m unittest discover -s csp/gate -p 'test_csp_checkout_gate.py' -v
No Docker, no browser, no network: every program the gate starts is a recording
fake, and the real runner is exercised only against Python itself. The last
class mutates the real source and requires these same tests to go red.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from types import ModuleType

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # the gate imports real_test_mode from its own directory

import real_test_mode  # noqa: E402 - after the path is set

SOURCE = HERE / "csp-checkout-gate.py"
LIB_SH = HERE / "lib.sh"
PID = 4242
SESSION_COOKIE = "ghost-admin-api-session=s%3Aabc.def"
STRIPE_POLICY = "default-src 'self'; script-src 'self' https://js.stripe.com"
NONE_POLICY = "default-src 'self'; script-src 'self'"


# Shaped like the owner's TEST-mode keys but made up and assembled at run time, so no
# secret scanner trips on this file. Each carries a marker, so a leak of any one is
# found by name wherever it appears.
def made_up(prefix: str, marker: str) -> str:
    return "_".join([*prefix.split("_"), marker + "Z" * 16])


OWNER_SECRET = made_up("sk_test", "OwnerSecretMarker")
OWNER_PUBLISHABLE = made_up("pk_test", "OwnerPubMarker")
OWNER_WEBHOOK = made_up("whsec", "OwnerHookMarker")
OWNER_KEYS = {
    "STRIPE_TEST_SECRET_KEY": OWNER_SECRET,
    "STRIPE_TEST_PUBLISHABLE_KEY": OWNER_PUBLISHABLE,
    "STRIPE_TEST_WEBHOOK_SECRET": OWNER_WEBHOOK,
}
MARKERS = ("OwnerSecretMarker", "OwnerPubMarker", "OwnerHookMarker")
REAL_ENV = {**OWNER_KEYS, "CSP_STRIPE_REAL_TEST_MODE": "1"}


def load(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


REAL = load(SOURCE, "csp_checkout_gate_real")


class Harness:
    """The gate wired to fakes: records every command, answers like the real tools."""

    def __init__(
        self,
        gate: ModuleType,
        environ: Mapping[str, str] | None = None,
        answers: Sequence[Callable[[object], object]] = (),
        built: bool = True,
    ) -> None:
        self.gate = gate
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        if built:
            dist = self.root / "render-core" / "dist"
            dist.mkdir(parents=True)
            (dist / "index.js").write_text("")
        self.answers = list(answers)
        self.calls: list[object] = []
        self.sleeps: list[float] = []
        self.clock = 1000
        self.keys = 0
        self.out = io.StringIO()
        self.err = io.StringIO()
        self.deps = gate.Deps(
            repo_root=self.root,
            environ=dict(environ or {}),
            run=self.run_command,
            now=lambda: self.clock,
            sleep=self.sleep,
            pid=PID,
            token=self.token,
            out=self.out,
            err=self.err,
        )

    def close(self) -> None:
        self.tmp.cleanup()

    def token(self) -> str:
        self.keys += 1
        return f"KEY{self.keys:021d}"

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
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
        if argv[0] != "node":
            return result(0)
        script = Path(argv[1]).name
        env = command.env
        if script == "setup-content.mjs":
            lines = ["POST_SLUG=post-slug", "TAG_SLUG=tag-slug", "AUTHOR_SLUG=author-slug"]
            lines.append(f'SESSION_COOKIE="{SESSION_COOKIE}"')
            return result(0, "\n".join(lines) + "\n")
        if script == "setup-paid.mjs":
            return result(0, "noise the gate must not print\n")
        if script == "derive-script-hashes.mjs":
            return result(0, '{"kind":"computed","scriptHashes":["sha256-AAAA"]}\n')
        if script == "render-header.mjs":
            policy = STRIPE_POLICY if env.get("CSP_PAYMENTS") == "stripe" else NONE_POLICY
            return result(0, f"enforcing\t{policy}\n")
        if script == "capture-checkout.mjs":
            self.clock += 7
            return result(0, '{"label":"' + env["PROOF_LABEL"] + '"}\n\n')
        return result(0)

    def go(self, *args: str) -> int:
        return int(self.gate.main(list(args), self.deps))

    def labels(self) -> list[str]:
        return [label(command) for command in self.calls]

    def commands(self, *prefix: str) -> list[object]:
        return [c for c in self.calls if c.argv[: len(prefix)] == prefix]

    def node(self, script: str) -> object:
        (found,) = [c for c in self.calls if c.argv[0] == "node" and c.argv[1].endswith(script)]
        return found


def label(command: object) -> str:
    argv = command.argv
    if argv[0] == "node":
        return f"node {Path(argv[1]).name}"
    if argv[:2] == ("docker", "run"):
        name = argv[argv.index("--name") + 1]
        return "docker run " + re.sub(r"csp-checkout-(\w+)-\d+", r"\1", name)
    if argv[0] == "curl":
        return f"curl {argv[-1]}"
    if argv[:2] == ("docker", "build"):
        return "docker build " + argv[argv.index("-t") + 1]
    if argv[:3] == ("docker", "network", "create") or argv[:3] == ("docker", "network", "rm"):
        return " ".join(argv[:3])
    return " ".join(argv[:2])


class BehaviourTests:
    """The gate's behaviour. `gate` is the module under test (real or mutated)."""

    gate: ModuleType

    def harness(self, **kwargs: object) -> Harness:
        harness = Harness(self.gate, **kwargs)
        self.addCleanup(harness.close)
        return harness

    def failing(self, wanted: str, code: int) -> Callable[[object], object]:
        """An answer making the command with this label exit with `code`."""

        def answer(command: object) -> object:
            return self.gate.Result(code) if label(command) == wanted else None

        return answer

    # --- the command line ---------------------------------------------------

    def test_no_arguments_means_enforcing_run_with_default_image(self) -> None:
        options = self.gate.parse_args([])
        self.assertEqual((options.sabotage, options.derive, options.image), ("", False, ""))

    def test_the_flags_and_image_are_read(self) -> None:
        options = self.gate.parse_args(["--derive", "--sabotage=no-stripe-origin", "ghost:1"])
        self.assertEqual(
            (options.sabotage, options.derive, options.image),
            ("no-stripe-origin", True, "ghost:1"),
        )

    def test_the_last_image_argument_wins_and_an_empty_one_clears_it(self) -> None:
        self.assertEqual(self.gate.parse_args(["a:1", "b:2"]).image, "b:2")
        self.assertEqual(self.gate.parse_args(["a:1", ""]).image, "")

    def test_an_unknown_sabotage_exits_two_naming_it_and_runs_nothing(self) -> None:
        for arg in ("--sabotage=bogus", "--sabotage="):
            with self.subTest(arg=arg):
                harness = self.harness()
                self.assertEqual(harness.go(arg), 2)
                self.assertEqual(harness.err.getvalue(), f"unknown sabotage: {arg}\n")
                self.assertEqual(harness.out.getvalue(), "")
                self.assertEqual(harness.calls, [])

    def test_an_unknown_sabotage_is_refused_even_after_an_image(self) -> None:
        harness = self.harness()
        self.assertEqual(harness.go("ghost:1", "--sabotage=bogus"), 2)
        self.assertEqual(harness.calls, [])

    # --- refusals before anything starts -------------------------------------

    def test_derive_needs_the_real_stripe_js(self) -> None:
        for environ in ({}, {"CSP_STRIPE_REAL_JS": ""}, {"CSP_STRIPE_REAL_JS": "0"}):
            with self.subTest(environ=environ):
                harness = self.harness(environ=environ)
                self.assertEqual(harness.go("--derive"), 2)
                self.assertEqual(
                    harness.err.getvalue(),
                    "--derive measures the origins the REAL Stripe.js needs: "
                    "run it with CSP_STRIPE_REAL_JS=1\n",
                )
                self.assertEqual(harness.calls, [])

    def test_an_unbuilt_render_core_is_refused_before_anything_starts(self) -> None:
        harness = self.harness(built=False)
        self.assertEqual(harness.go(), 2)
        self.assertEqual(
            harness.err.getvalue(),
            "render-core is not built: the policy is rendered through its built "
            "output (cd render-core && pnpm run build)\n",
        )
        self.assertEqual(harness.calls, [])

    def test_the_derive_refusal_comes_before_the_build_check(self) -> None:
        harness = self.harness(built=False)
        self.assertEqual(harness.go("--derive"), 2)
        self.assertIn("--derive measures", harness.err.getvalue())

    # --- the enforcing run ---------------------------------------------------

    def test_a_green_run_prints_the_policy_the_capture_and_the_timing(self) -> None:
        harness = self.harness()
        self.assertEqual(harness.go(), 0)
        self.assertEqual(
            harness.out.getvalue(),
            f"POLICY payments=stripe: {STRIPE_POLICY}\n"
            '{"label":"checkout"}\n'
            "GATE_TIMING seconds=7 sabotage=none exit=0\n",
        )
        self.assertEqual(harness.err.getvalue(), "")

    def test_the_whole_command_sequence_of_a_green_run(self) -> None:
        harness = self.harness()
        harness.go()
        origin = "http://localhost:4321/"
        self.assertEqual(
            harness.labels(),
            [
                "docker build csp-gate-ghost:local",
                "docker build csp-gate-origin:local",
                "docker network create",
                "docker run stripe",
                "docker run ghost",
                "docker exec",
                "docker rm",
                "docker run origin",
                f"curl {origin}",
                "curl http://localhost:4322/__state",
                "node setup-content.mjs",
                "node setup-paid.mjs",
                "node derive-script-hashes.mjs",
                "node render-header.mjs",
                "docker rm",
                "docker run origin",
                f"curl {origin}",
                "node capture-checkout.mjs",
                "node checkout-gate.mjs",
                "docker rm",
                "docker network rm",
            ],
        )

    def test_the_images_are_built_quietly_from_the_repo_root(self) -> None:
        harness = self.harness()
        harness.go()
        ghost, origin = harness.commands("docker", "build")
        self.assertEqual(ghost.argv, ("docker", "build", "-q", "-t", "csp-gate-ghost:local", "."))
        self.assertEqual(
            origin.argv,
            (
                "docker",
                "build",
                "-q",
                "-f",
                "csp/proof/Dockerfile",
                "-t",
                "csp-gate-origin:local",
                ".",
            ),
        )
        self.assertEqual(ghost.stdout, "discard")

    def test_a_given_image_is_used_and_the_ghost_image_is_not_built(self) -> None:
        harness = self.harness()
        harness.go("registry/ghost:pinned")
        self.assertEqual(len(harness.commands("docker", "build")), 1)
        fake, ghost = harness.commands("docker", "run")[:2]
        self.assertEqual(
            fake.argv[-3:], ("node", "registry/ghost:pinned", "/proof/fake-stripe.mjs")
        )
        self.assertEqual(ghost.argv[-1], "registry/ghost:pinned")

    def test_the_fake_stripe_container(self) -> None:
        harness = self.harness()
        harness.go()
        fake = harness.commands("docker", "run")[0]
        argv = fake.argv
        self.assertEqual(argv[:8], (
            "docker", "run", "-d", "--name", f"csp-checkout-stripe-{PID}",
            "--network", f"csp-checkout-net-{PID}", "-p",
        ))  # fmt: skip
        self.assertEqual(argv[8], "127.0.0.1:4322:12111")
        self.assertEqual(argv[9:11], ("-v", f"{harness.root}/csp/proof:/proof:ro"))
        settings = dict(s.split("=", 1) for s in argv[11:] if "=" in s and not s.startswith("/"))
        self.assertEqual(settings["FAKE_STRIPE_PUBLIC_URL"], "http://localhost:4322")
        self.assertEqual(
            settings["FAKE_STRIPE_WEBHOOK_URL"],
            f"http://csp-checkout-ghost-{PID}:2368/members/webhooks/stripe/",
        )
        self.assertRegex(settings["FAKE_STRIPE_WEBHOOK_SECRET"], r"^whsec_KEY\d+$")
        self.assertEqual(
            argv[-4:], ("--entrypoint", "node", "csp-gate-ghost:local", "/proof/fake-stripe.mjs")
        )

    def test_ghost_points_at_the_fake_and_shares_its_webhook_secret(self) -> None:
        harness = self.harness()
        harness.go()
        fake, ghost = harness.commands("docker", "run")[:2]
        argv = ghost.argv
        settings = [argv[i + 1] for i, part in enumerate(argv) if part == "-e"]
        self.assertIn("stripeDirect=true", settings)
        self.assertIn(f"STRIPE_API_HOST=csp-checkout-stripe-{PID}", settings)
        self.assertIn("STRIPE_API_PORT=12111", settings)
        self.assertIn("STRIPE_API_PROTOCOL=http", settings)
        self.assertIn("url=http://localhost:4321", settings)
        secret = next(s for s in settings if s.startswith("WEBHOOK_SECRET=")).split("=", 1)[1]
        self.assertIn(f"FAKE_STRIPE_WEBHOOK_SECRET={secret}", fake.argv)
        self.assertEqual(argv[-1], "csp-gate-ghost:local")

    def test_ghost_is_waited_for_with_a_90_second_probe(self) -> None:
        harness = self.harness()
        harness.go()
        (probe,) = harness.commands("docker", "exec")
        self.assertEqual(
            probe.argv,
            (
                "docker",
                "exec",
                f"csp-checkout-ghost-{PID}",
                "wget",
                "-q",
                "-O",
                "/dev/null",
                "http://127.0.0.1:2368/",
            ),
        )
        self.assertEqual(probe.stderr, "discard")

    def test_the_origin_serves_a_marker_then_the_policy_under_test(self) -> None:
        harness = self.harness()
        harness.go()
        first, second = harness.commands("docker", "run")[2:4]
        for command, header, value in (
            (first, "X-Csp-Gate-Marker", "none"),
            (second, "Content-Security-Policy", STRIPE_POLICY),
        ):
            argv = command.argv
            self.assertIn(f"CSP_HEADER_NAME={header}", argv)
            self.assertIn(f"CSP_HEADER_VALUE={value}", argv)
            self.assertIn(f"GHOST_UPSTREAM=csp-checkout-ghost-{PID}:2368", argv)
            self.assertIn("4321:8080", argv)
            self.assertEqual(argv[-1], "csp-gate-origin:local")

    def test_the_setup_steps_get_the_origin_the_cookie_and_synthetic_test_keys(self) -> None:
        harness = self.harness()
        harness.go()
        content = harness.node("setup-content.mjs")
        self.assertEqual(content.env, {"PROOF_ORIGIN": "http://localhost:4321"})
        paid = harness.node("setup-paid.mjs")
        env = paid.env
        self.assertEqual(env["PROOF_SESSION_COOKIE"], SESSION_COOKIE)
        self.assertRegex(env["PROOF_STRIPE_SECRET_KEY"], r"^sk_test_KEY\d+$")
        self.assertRegex(env["PROOF_STRIPE_PUBLISHABLE_KEY"], r"^pk_test_KEY\d+$")
        self.assertEqual(paid.stdout, "discard")
        self.assertNotIn("noise", harness.out.getvalue())

    def test_the_script_hashes_come_from_the_four_clean_pages(self) -> None:
        harness = self.harness()
        harness.go()
        env = harness.node("derive-script-hashes.mjs").env
        self.assertEqual(env["GHOST_ORIGIN"], "http://localhost:4321")
        self.assertEqual(
            env["CSP_DERIVE_PATHS"], "/,/post-slug/,/tag/tag-slug/,/author/author-slug/"
        )

    def test_the_policy_is_rendered_from_the_hashes_with_payments_stripe(self) -> None:
        harness = self.harness()
        harness.go()
        render = harness.node("render-header.mjs")
        self.assertEqual(render.env, {"CSP_PAYMENTS": "stripe"})
        self.assertEqual(render.stdin, '{"kind":"computed","scriptHashes":["sha256-AAAA"]}')

    def test_the_capture_gets_the_origin_label_cookie_and_stripe_url(self) -> None:
        harness = self.harness()
        harness.go()
        env = harness.node("capture-checkout.mjs").env
        self.assertEqual(
            env,
            {
                "PROOF_ORIGIN": "http://localhost:4321",
                "PROOF_LABEL": "checkout",
                "PROOF_SESSION_COOKIE": SESSION_COOKIE,
                "PROOF_STRIPE_URL": "http://localhost:4322",
            },
        )

    def test_the_verdict_step_is_given_the_capture_without_its_trailing_newlines(self) -> None:
        harness = self.harness()
        harness.go()
        self.assertEqual(harness.node("checkout-gate.mjs").stdin, '{"label":"checkout"}')

    def test_the_verdict_steps_exit_code_is_the_gates_exit_code(self) -> None:
        for code in (1, 3):
            with self.subTest(code=code):
                harness = self.harness(answers=[self.failing("node checkout-gate.mjs", code)])
                self.assertEqual(harness.go(), code)
                self.assertIn(f"exit={code}\n", harness.out.getvalue())

    def test_ports_come_from_the_environment_and_empty_means_default(self) -> None:
        harness = self.harness(
            environ={"CSP_CHECKOUT_PORT": "5001", "CSP_CHECKOUT_STRIPE_PORT": "5002"}
        )
        harness.go()
        self.assertIn("5001:8080", harness.commands("docker", "run")[2].argv)
        self.assertIn("127.0.0.1:5002:12111", harness.commands("docker", "run")[0].argv)
        self.assertEqual(
            harness.node("capture-checkout.mjs").env["PROOF_STRIPE_URL"], "http://localhost:5002"
        )
        empty = self.harness(environ={"CSP_CHECKOUT_PORT": "", "CSP_CHECKOUT_STRIPE_PORT": ""})
        empty.go()
        self.assertIn("4321:8080", empty.commands("docker", "run")[2].argv)

    # --- the sabotage --------------------------------------------------------

    def test_the_sabotage_serves_the_policy_without_the_payments_allowance(self) -> None:
        harness = self.harness()
        self.assertEqual(harness.go("--sabotage=no-stripe-origin"), 0)
        self.assertEqual(harness.node("render-header.mjs").env, {"CSP_PAYMENTS": "none"})
        self.assertEqual(
            harness.out.getvalue(),
            f"POLICY no-stripe-origin: {NONE_POLICY}\n"
            '{"label":"checkout-no-stripe-origin"}\n'
            "GATE_TIMING seconds=7 sabotage=no-stripe-origin exit=0\n",
        )

    def test_the_sabotage_run_reports_a_red_verdict(self) -> None:
        harness = self.harness(answers=[self.failing("node checkout-gate.mjs", 1)])
        self.assertEqual(harness.go("--sabotage=no-stripe-origin"), 1)
        self.assertTrue(harness.out.getvalue().endswith("sabotage=no-stripe-origin exit=1\n"))

    def test_a_policy_that_is_not_enforcing_is_refused(self) -> None:
        def report_only(command: object) -> object:
            if label(command) == "node render-header.mjs":
                return self.gate.Result(0, f"report-only\t{NONE_POLICY}\n")
            return None

        harness = self.harness(answers=[report_only])
        self.assertEqual(harness.go(), 2)
        self.assertEqual(
            harness.err.getvalue(),
            "FAILED: the policy under test is not enforcing (no theme hashes derived?)\n",
        )
        self.assertEqual(harness.out.getvalue(), "")
        self.assertNotIn("node capture-checkout.mjs", harness.labels())

    def test_a_failing_renderer_ends_the_run_with_its_exit_code(self) -> None:
        harness = self.harness(answers=[self.failing("node render-header.mjs", 5)])
        self.assertEqual(harness.go(), 5)
        self.assertEqual(harness.out.getvalue(), "")

    # --- derive mode ---------------------------------------------------------

    def derive_harness(self, **kwargs: object) -> Harness:
        return self.harness(environ={"CSP_STRIPE_REAL_JS": "1"}, **kwargs)

    def test_derive_serves_the_strict_policy_report_only_and_checks_the_capture(self) -> None:
        harness = self.derive_harness()
        self.assertEqual(harness.go("--derive"), 0)
        self.assertEqual(harness.node("render-header.mjs").env, {"CSP_PAYMENTS": "none"})
        origin = harness.commands("docker", "run")[3].argv
        self.assertIn("CSP_HEADER_NAME=Content-Security-Policy-Report-Only", origin)
        self.assertIn(f"CSP_HEADER_VALUE={NONE_POLICY}", origin)
        self.assertEqual(harness.node("capture-checkout.mjs").env["PROOF_LABEL"], "derive")
        check = harness.node("derive-payment-origins.mjs")
        self.assertEqual(check.argv[2:], ("--check",))
        self.assertEqual(check.stdin, '{"label":"derive"}')
        self.assertEqual(harness.out.getvalue(), '{"label":"derive"}\n')
        self.assertNotIn("node checkout-gate.mjs", harness.labels())

    def test_derives_exit_code_is_the_checks_exit_code(self) -> None:
        harness = self.derive_harness(answers=[self.failing("node derive-payment-origins.mjs", 1)])
        self.assertEqual(harness.go("--derive"), 1)

    def test_derive_ignores_the_sabotage_flag(self) -> None:
        harness = self.derive_harness()
        self.assertEqual(harness.go("--derive", "--sabotage=no-stripe-origin"), 0)
        self.assertEqual(harness.node("capture-checkout.mjs").env["PROOF_LABEL"], "derive")

    def test_derive_does_not_check_the_renderers_exit_status(self) -> None:
        harness = self.derive_harness(answers=[self.failing("node render-header.mjs", 4)])
        self.assertEqual(harness.go("--derive"), 0)

    # --- the steps that end the run ------------------------------------------

    def test_a_failed_setup_step_ends_the_run_with_its_exit_code_after_cleanup(self) -> None:
        steps = {
            "docker build csp-gate-ghost:local": 7,
            "docker build csp-gate-origin:local": 7,
            "docker network create": 8,
            "docker run stripe": 9,
            "docker run ghost": 10,
            "docker run origin": 11,
            "node setup-paid.mjs": 6,
            "node derive-script-hashes.mjs": 12,
            "node capture-checkout.mjs": 13,
        }
        for step, code in steps.items():
            with self.subTest(step=step):
                harness = self.harness(answers=[self.failing(step, code)])
                self.assertEqual(harness.go(), code)
                self.assertEqual(harness.labels()[-2:], ["docker rm", "docker network rm"])
                self.assertNotIn("node checkout-gate.mjs", harness.labels())

    def test_a_failed_setup_content_step_does_not_stop_the_run(self) -> None:
        def nothing(command: object) -> object:
            return self.gate.Result(1) if label(command) == "node setup-content.mjs" else None

        harness = self.harness(answers=[nothing])
        self.assertEqual(harness.go(), 0)
        self.assertEqual(harness.node("setup-paid.mjs").env["PROOF_SESSION_COOKIE"], "")
        self.assertEqual(
            harness.node("derive-script-hashes.mjs").env["CSP_DERIVE_PATHS"],
            "/,//,/tag//,/author//",
        )

    def test_a_missing_program_exits_127_like_the_shell(self) -> None:
        harness = self.harness(answers=[self.failing("docker network create", 127)])
        self.assertEqual(harness.go(), 127)

    # --- waiting ---------------------------------------------------------------

    def test_a_probe_is_retried_every_second_until_it_succeeds(self) -> None:
        attempts: list[str] = []

        def third_time(command: object) -> object:
            if label(command) == "docker exec":
                attempts.append("exec")
                return self.gate.Result(0 if len(attempts) == 3 else 1)
            return None

        harness = self.harness(answers=[third_time])
        self.assertEqual(harness.go(), 0)
        self.assertEqual(len(attempts), 3)
        self.assertEqual(harness.sleeps, [1, 1])

    def test_a_probe_that_never_succeeds_exits_two_after_its_deadline(self) -> None:
        cases = {
            "docker exec": ("Ghost", 90),
            "curl http://localhost:4321/": ("origin", 30),
            "curl http://localhost:4322/__state": ("fake Stripe", 30),
        }
        for probe, (name, seconds) in cases.items():
            with self.subTest(probe=name):
                harness = self.harness(answers=[self.failing(probe, 22)])
                self.assertEqual(harness.go(), 2)
                self.assertEqual(
                    harness.err.getvalue(), f"FAILED: {name} not ready within {seconds}s\n"
                )
                self.assertEqual(len(harness.sleeps), seconds)
                self.assertEqual(harness.labels()[-2:], ["docker rm", "docker network rm"])

    # --- cleanup ---------------------------------------------------------------

    def test_cleanup_removes_the_containers_then_the_network_and_ignores_failure(self) -> None:
        harness = self.harness()
        harness.go()
        remove, network = harness.calls[-2:]
        self.assertEqual(
            remove.argv,
            (
                "docker", "rm", "-fv",
                f"csp-checkout-ghost-{PID}", f"csp-checkout-origin-{PID}", f"csp-checkout-stripe-{PID}",
            ),
        )  # fmt: skip
        self.assertEqual(network.argv, ("docker", "network", "rm", f"csp-checkout-net-{PID}"))
        for command in (remove, network):
            self.assertEqual((command.stdout, command.stderr), ("discard", "discard"))

    def test_cleanup_still_runs_when_the_run_is_interrupted(self) -> None:
        def interrupt(command: object) -> object:
            if label(command) == "node capture-checkout.mjs":
                raise KeyboardInterrupt
            return None

        harness = self.harness(answers=[interrupt])
        with self.assertRaises(KeyboardInterrupt):
            harness.go()
        self.assertEqual(harness.labels()[-2:], ["docker rm", "docker network rm"])


    # --- real Stripe test mode (the owner's opt-in) ---------------------------------

    def argv_text(self, harness: Harness) -> str:
        return "\n".join(" ".join(command.argv) for command in harness.calls)

    def assert_no_key_shown(self, harness: Harness) -> None:
        seen = "\n".join(
            [self.argv_text(harness), harness.out.getvalue(), harness.err.getvalue()]
            + [repr(command) for command in harness.calls]
        )
        for marker in MARKERS:
            self.assertNotIn(marker, seen, f"{marker} was shown")

    def test_a_real_run_preflights_first_and_starts_no_fake(self) -> None:
        harness = self.harness(environ=REAL_ENV)
        self.assertEqual(harness.go(), 0)
        self.assertIn("real test mode: keys accepted", harness.out.getvalue())
        self.assertEqual(
            harness.labels(),
            [
                "docker build csp-gate-ghost:local",
                "docker build csp-gate-origin:local",
                "docker network create",
                "docker run ghost",
                "docker exec",
                "docker rm",
                "docker run origin",
                "curl http://localhost:4321/",
                "node setup-content.mjs",
                "node setup-paid.mjs",
                "node derive-script-hashes.mjs",
                "node render-header.mjs",
                "docker rm",
                "docker run origin",
                "curl http://localhost:4321/",
                "node capture-checkout.mjs",
                "node checkout-gate.mjs",
                "docker rm",
                "docker network rm",
            ],
        )

    def test_the_preflight_judges_this_runs_origin(self) -> None:
        for port in ("4321", "5555"):
            with self.subTest(port=port):
                environ = {**REAL_ENV, "CSP_CHECKOUT_PORT": port}
                harness = self.harness(environ=environ)
                harness.go()
                seen = harness.out.getvalue()
                self.assertIn(f"tenant http://localhost:{port}\n", seen)
                self.assertIn(
                    f"stripe listen --forward-to http://localhost:{port}/members/webhooks/stripe/",
                    seen,
                )

    def test_a_failed_preflight_exits_two_prints_the_rules_and_starts_nothing(self) -> None:
        live = made_up("sk_live", "LiveSecretMarker")
        cases = {
            "no keys": ({"CSP_STRIPE_REAL_TEST_MODE": "1"}, "STRIPE_TEST_WEBHOOK_SECRET: is not set"),
            "live key": ({**REAL_ENV, "STRIPE_TEST_SECRET_KEY": live}, "LIVE secret key is refused"),
            "other card": (
                {**REAL_ENV, "CSP_STRIPE_TEST_CARD": "4000 0000 0000 0002"},
                "CSP_STRIPE_TEST_CARD",
            ),
            "tenant off this machine": (
                {**REAL_ENV, "CSP_CHECKOUT_PORT": "4321@tenant.example.com"},
                "local disposable tenant",
            ),
        }
        for name, (environ, wanted) in cases.items():
            with self.subTest(case=name):
                harness = self.harness(environ=environ)
                self.assertEqual(harness.go(), 2)
                self.assertEqual(harness.calls, [])
                self.assertIn("REAL TEST MODE REFUSED:", harness.err.getvalue())
                self.assertIn(wanted, harness.err.getvalue())
                self.assertIn(real_test_mode.owner_command(), harness.err.getvalue())
                self.assertEqual(harness.out.getvalue(), "")
                self.assert_no_key_shown(harness)
                self.assertNotIn("LiveSecretMarker", harness.err.getvalue())

    def test_a_switch_value_other_than_one_is_refused_before_anything_runs(self) -> None:
        harness = self.harness(environ={**REAL_ENV, "CSP_STRIPE_REAL_TEST_MODE": "yes"})
        self.assertEqual(harness.go(), 2)
        self.assertEqual(
            harness.err.getvalue(),
            "CSP_STRIPE_REAL_TEST_MODE must be 1 (or unset for the fake Stripe)\n",
        )
        self.assertEqual(harness.calls, [])
        help_too = self.harness(environ={"CSP_STRIPE_REAL_TEST_MODE": "yes"})
        self.assertEqual(help_too.go("--help"), 2)
        self.assertEqual(help_too.calls, [])

    def test_an_empty_switch_is_the_fake_stripe(self) -> None:
        harness = self.harness(environ={**OWNER_KEYS, "CSP_STRIPE_REAL_TEST_MODE": ""})
        harness.go()
        self.assertIn("docker run stripe", harness.labels())
        self.assertNotRegex(harness.out.getvalue() + harness.err.getvalue(), r"(?i)real test mode")

    def test_real_mode_refuses_derive_even_with_the_real_stripe_js(self) -> None:
        harness = self.harness(environ={**REAL_ENV, "CSP_STRIPE_REAL_JS": "1"})
        self.assertEqual(harness.go("--derive"), 2)
        self.assertIn("--derive", harness.err.getvalue())
        self.assertEqual(harness.calls, [])

    def test_help_prints_the_modules_usage_and_exits_zero_without_docker(self) -> None:
        for flag in ("--help", "-h"):
            with self.subTest(flag=flag):
                harness = self.harness()
                self.assertEqual(harness.go(flag), 0)
                self.assertEqual(harness.calls, [])
                self.assertEqual(harness.out.getvalue(), real_test_mode.usage() + "\n")
                self.assertIn(
                    "CSP_STRIPE_REAL_TEST_MODE=1 csp/gate/csp-checkout-gate.py", harness.out.getvalue()
                )

    def test_real_ghost_has_no_fake_and_the_webhook_secret_only_by_name(self) -> None:
        harness = self.harness(environ=REAL_ENV)
        harness.go()
        (ghost, origin1, origin2) = harness.commands("docker", "run")
        argv = ghost.argv
        settings = [argv[i + 1] for i, part in enumerate(argv) if part == "-e"]
        self.assertIn("stripeDirect=true", settings)
        self.assertIn("WEBHOOK_SECRET", settings)
        self.assertEqual(
            [s for s in settings if s.startswith(("STRIPE_API", "WEBHOOK_SECRET="))], []
        )
        self.assertEqual(argv[-1], "csp-gate-ghost:local")
        self.assertEqual(ghost.env, {"WEBHOOK_SECRET": OWNER_WEBHOOK})
        self.assertEqual(self.argv_text(harness).count("fake-stripe"), 0)
        self.assertEqual(harness.commands("curl", "-sf", "-o", "/dev/null", "http://localhost:4322/__state"), [])

    def test_real_keys_reach_the_setup_step_by_environment_with_the_flag_on(self) -> None:
        harness = self.harness(environ=REAL_ENV)
        harness.go()
        paid = harness.node("setup-paid.mjs")
        self.assertEqual(paid.env["PROOF_STRIPE_SECRET_KEY"], OWNER_SECRET)
        self.assertEqual(paid.env["PROOF_STRIPE_PUBLISHABLE_KEY"], OWNER_PUBLISHABLE)
        self.assertEqual(paid.stdout, "discard")
        for command in harness.calls:
            if command.argv[0] == "node":
                self.assertEqual(
                    command.env.get("PROOF_REAL_TEST_MODE"), "1", " ".join(command.argv)
                )
        self.assert_no_key_shown(harness)

    def test_no_owner_key_is_in_any_argument_or_line_printed_or_command_repr(self) -> None:
        harness = self.harness(environ=REAL_ENV)
        harness.go()
        self.assert_no_key_shown(harness)

    def test_a_missing_owner_key_after_preflight_is_refused_naming_only_the_variable(self) -> None:
        # Preflight already refuses this; the read of each key checks again by itself.
        env = {k: v for k, v in REAL_ENV.items() if k != "STRIPE_TEST_WEBHOOK_SECRET"}
        harness = self.harness(environ=env)
        gate = self.gate.Gate(harness.deps, self.gate.parse_args([]))
        with self.assertRaises(self.gate.GateError) as caught:
            gate.required_env("STRIPE_TEST_WEBHOOK_SECRET")
        self.assertEqual(
            (caught.exception.code, caught.exception.message),
            (2, "STRIPE_TEST_WEBHOOK_SECRET is not set"),
        )
        self.assertEqual(gate.required_env("STRIPE_TEST_SECRET_KEY"), OWNER_SECRET)

    def test_without_the_switch_the_owner_variables_are_never_read(self) -> None:
        harness = self.harness(environ=OWNER_KEYS)
        harness.go()
        paid = harness.node("setup-paid.mjs")
        self.assertRegex(paid.env["PROOF_STRIPE_SECRET_KEY"], r"^sk_test_KEY\d+$")
        self.assertRegex(paid.env["PROOF_STRIPE_PUBLISHABLE_KEY"], r"^pk_test_KEY\d+$")
        for command in harness.calls:
            self.assertNotIn("PROOF_REAL_TEST_MODE", command.env)
            self.assertEqual(command.env.get("WEBHOOK_SECRET"), None)
        self.assert_no_key_shown(harness)

    def test_every_removal_takes_the_anonymous_volumes_with_it(self) -> None:
        for environ in ({}, REAL_ENV):
            with self.subTest(real=bool(environ)):
                harness = self.harness(environ=environ)
                harness.go()
                removals = harness.commands("docker", "rm")
                self.assertEqual(len(removals), 3)  # origin restarts (2) and the cleanup
                for command in removals:
                    self.assertEqual(command.argv[:3], ("docker", "rm", "-fv"), command.argv)

    def test_a_real_run_cleans_up_when_a_step_fails(self) -> None:
        harness = self.harness(
            environ=REAL_ENV, answers=[self.failing("node setup-paid.mjs", 5)]
        )
        self.assertEqual(harness.go(), 5)
        self.assertEqual(harness.labels()[-2:], ["docker rm", "docker network rm"])
        self.assertEqual(harness.commands("docker", "rm")[-1].argv[:3], ("docker", "rm", "-fv"))

    def test_real_mode_takes_every_node_steps_stderr_in_and_the_default_run_does_not(self) -> None:
        for environ, wanted in ((REAL_ENV, "capture"), ({}, "inherit")):
            with self.subTest(real=bool(environ)):
                harness = self.harness(environ=environ)
                harness.go()
                nodes = [c for c in harness.calls if c.argv[0] == "node"]
                self.assertGreater(len(nodes), 4)
                for command in nodes:
                    self.assertEqual(command.stderr, wanted, " ".join(command.argv))

    def test_what_a_node_step_says_on_stderr_is_printed_with_every_secret_redacted(self) -> None:
        odd = "unshaped-env-secret-value-98765"
        noisy = f"boom {OWNER_SECRET} and {OWNER_WEBHOOK} and {odd}\n"

        def answer(command: object) -> object:
            if label(command) == "node setup-paid.mjs":
                return self.gate.Result(0, "", noisy)
            return None

        harness = self.harness(
            environ={**REAL_ENV, "WEBHOOK_SECRET": odd}, answers=[answer]
        )
        self.assertEqual(harness.go(), 0)
        self.assertEqual(harness.err.getvalue(), "boom [REDACTED] and [REDACTED] and [REDACTED]\n")
        self.assertNotIn(odd, harness.out.getvalue() + harness.err.getvalue())
        self.assert_no_key_shown(harness)

    def test_stderr_of_a_default_run_is_not_touched(self) -> None:
        harness = self.harness()
        harness.go()
        self.assertEqual(harness.err.getvalue(), "")

    def capture_with(self, run: dict[str, object], environ: Mapping[str, str]) -> Harness:
        def answer(command: object) -> object:
            if label(command) == "node capture-checkout.mjs":
                return self.gate.Result(0, json.dumps(run) + "\n")
            return None

        harness = self.harness(environ=environ, answers=[answer])
        self.assertEqual(harness.go(), 0)
        return harness

    def test_a_real_capture_is_redacted_and_stripes_own_violations_are_counted_apart(self) -> None:
        tenant = {"directive": "script-src", "documentURI": "http://localhost:4321/"}
        stripe = {"directive": "frame-src", "documentURI": "https://checkout.stripe.com/c/pay/cs_test_x"}
        run = {
            "mode": "real-test-mode",
            "error": f"boom {OWNER_SECRET}",
            "violations": [tenant, stripe, {"directive": "x"}],
            "url": "https://checkout.stripe.com/c/pay/cs_test_x#fidkdWxOYHwn",
        }
        harness = self.capture_with(run, REAL_ENV)
        judged = json.loads(harness.node("checkout-gate.mjs").stdin or "")
        self.assertEqual(judged["violations"], [tenant, {"directive": "x"}])  # unplaceable: ours
        self.assertEqual(judged["foreignViolations"], 1)
        self.assertEqual(judged["error"], "boom [REDACTED]")
        self.assertEqual(judged["url"], "https://checkout.stripe.com/c/pay/cs_test_x#[REDACTED]")
        self.assertIn(harness.node("checkout-gate.mjs").stdin or "", harness.out.getvalue())
        self.assert_no_key_shown(harness)

    def test_a_default_capture_is_passed_to_the_judge_untouched(self) -> None:
        stripe = {"directive": "frame-src", "documentURI": "https://checkout.stripe.com/c/pay/x"}
        text = json.dumps({"violations": [stripe], "error": f"boom {OWNER_SECRET}"})
        harness = self.capture_with({"violations": [stripe], "error": f"boom {OWNER_SECRET}"}, {})
        self.assertEqual(harness.node("checkout-gate.mjs").stdin, text)

    def test_a_command_never_shows_its_environment_when_printed(self) -> None:
        command = self.gate.Command(("x",), env={"STRIPE_TEST_SECRET_KEY": OWNER_SECRET})
        self.assertNotIn("OwnerSecretMarker", repr(command))

    # --- helpers -----------------------------------------------------------------

    def test_cut_field_reads_tab_separated_lines_like_cut(self) -> None:
        cut = self.gate.cut_field
        self.assertEqual(cut("enforcing\tdefault-src 'self'", 1), "enforcing")
        self.assertEqual(cut("enforcing\tdefault-src 'self'", 2), "default-src 'self'")
        self.assertEqual(cut("no tab here", 1), "no tab here")
        self.assertEqual(cut("no tab here", 2), "no tab here")
        self.assertEqual(cut("a\tb", 3), "")
        self.assertEqual(cut("a\tb\n", 2), "b")
        self.assertEqual(cut("", 2), "")

    def test_the_setup_output_is_read_the_way_eval_reads_assignments(self) -> None:
        text = f'POST_SLUG=p\nTAG_SLUG=t\nSESSION_COOKIE="{SESSION_COOKIE}"\nnot an assignment\nBROKEN="x\n'
        self.assertEqual(
            self.gate.parse_assignments(text),
            {"POST_SLUG": "p", "TAG_SLUG": "t", "SESSION_COOKIE": SESSION_COOKIE},
        )

    def test_the_ghost_arguments_are_the_ones_lib_sh_passes(self) -> None:
        text = LIB_SH.read_text()
        body = text.split("ghost_start() {", 1)[1].split('"$@"', 1)[0]
        flags = shlex.split(body.replace("\\\n", " ").replace('"$_origin', '"ORIGIN'))
        shell_settings = [flags[i + 1] for i, flag in enumerate(flags) if flag == "-e"]
        args = self.gate.ghost_run_args("NAME", "NET", "ORIGIN", "IMAGE")
        python_settings = [
            args[i + 1] for i, part in enumerate(args) if part == "-e"
        ]
        self.assertEqual(python_settings, shell_settings)
        self.assertEqual(args[:7], ("docker", "run", "-d", "--name", "NAME", "--network", "NET"))
        self.assertEqual(args[-1], "IMAGE")

    def test_main_prints_a_refusal_to_stderr_and_returns_its_code(self) -> None:
        harness = self.harness()
        self.assertEqual(harness.go("--sabotage=nope"), 2)
        self.assertEqual(harness.out.getvalue(), "")


class Behaviour(BehaviourTests, unittest.TestCase):
    gate = REAL


class RealRunner(unittest.TestCase):
    """The real runner, against Python itself; and the real command line."""

    def run_py(self, code: str, **kwargs: object) -> object:
        runner = REAL.run_subprocess(HERE)
        command = REAL.Command((sys.executable, "-c", code), **kwargs)
        return runner(command)

    def test_it_captures_stdout_and_returns_the_exit_code(self) -> None:
        result = self.run_py("print('out'); raise SystemExit(3)", stdout="capture")
        self.assertEqual((result.returncode, result.stdout), (3, "out\n"))

    def test_it_passes_stdin_and_extra_environment(self) -> None:
        code = "import os, sys; print(sys.stdin.read() + os.environ['GATE_TEST_VALUE'])"
        result = self.run_py(code, stdin="in:", env={"GATE_TEST_VALUE": "env"}, stdout="capture")
        self.assertEqual(result.stdout, "in:env\n")

    def test_it_runs_in_the_repo_root_it_was_given(self) -> None:
        result = self.run_py("import os; print(os.getcwd())", stdout="capture")
        self.assertEqual(Path(result.stdout.strip()).resolve(), HERE.resolve())

    def test_captured_stderr_is_returned_and_not_inherited(self) -> None:
        code = "import sys; sys.stderr.write('said'); raise SystemExit(4)"
        result = self.run_py(code, stderr="capture")
        self.assertEqual((result.returncode, result.stderr), (4, "said"))

    def test_a_missing_program_with_captured_stderr_says_so_in_the_result(self) -> None:
        runner = REAL.run_subprocess(HERE)
        result = runner(REAL.Command(("no-such-program-for-the-gate-test",), stderr="capture"))
        self.assertEqual(
            (result.returncode, result.stderr),
            (127, "no-such-program-for-the-gate-test: command not found\n"),
        )

    def test_discarded_output_is_not_returned(self) -> None:
        result = self.run_py("print('gone')", stdout="discard")
        self.assertEqual(result.stdout, "")

    def test_a_missing_program_is_exit_127(self) -> None:
        runner = REAL.run_subprocess(HERE)
        result = runner(REAL.Command(("no-such-program-for-the-gate-test",), stderr="discard"))
        self.assertEqual(result.returncode, 127)

    def test_the_program_refuses_an_unknown_sabotage_from_the_command_line(self) -> None:
        done = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [sys.executable, str(SOURCE), "--sabotage=bogus"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            (done.returncode, done.stdout, done.stderr),
            (2, "", "unknown sabotage: --sabotage=bogus\n"),
        )

    def test_the_program_is_executable_and_has_a_python_shebang(self) -> None:
        self.assertTrue(SOURCE.stat().st_mode & 0o111)
        self.assertEqual(SOURCE.read_text().splitlines()[0], "#!/usr/bin/env python3")

    def test_random_keys_are_24_alphanumerics_and_differ(self) -> None:
        first, second = REAL.random_key(), REAL.random_key()
        self.assertRegex(first, r"^[A-Za-z0-9]{24}$")
        self.assertNotEqual(first, second)


class RealModeCommandLine(unittest.TestCase):
    """The real program and the real preflight, with a docker that records any call.

    Every case here must refuse before it would start Docker; a shim docker on
    PATH fails the test if it is ever reached.
    """

    def run_gate(self, *args: str, env: Mapping[str, str]) -> tuple[subprocess.CompletedProcess[str], bool]:
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "docker-was-called"
            shim = Path(tmp) / "docker"
            shim.write_text(f'#!/bin/sh\ntouch "{marker}"\nexit 97\n')
            shim.chmod(0o755)
            done = subprocess.run(  # noqa: S603 - fixed argv, no shell
                [sys.executable, str(SOURCE), *args],
                capture_output=True,
                text=True,
                check=False,
                env={"PATH": f"{tmp}:{os.environ['PATH']}", **env},
            )
            return done, marker.exists()

    def seen(self, done: subprocess.CompletedProcess[str]) -> str:
        return done.stdout + done.stderr

    def test_real_mode_with_no_keys_refuses_naming_each_variable(self) -> None:
        done, docker_called = self.run_gate(env={"CSP_STRIPE_REAL_TEST_MODE": "1"})
        self.assertEqual(done.returncode, 2, done.stderr)
        for name in OWNER_KEYS:
            self.assertIn(name, done.stderr)
        self.assertFalse(docker_called)

    def test_real_mode_with_a_live_key_refuses_and_prints_no_value(self) -> None:
        live = made_up("sk_live", "LiveSecretMarker")
        done, docker_called = self.run_gate(
            env={**REAL_ENV, "STRIPE_TEST_SECRET_KEY": live}
        )
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("LIVE secret key is refused", done.stderr)
        for marker in (*MARKERS, "LiveSecretMarker"):
            self.assertNotIn(marker, self.seen(done))
        self.assertFalse(docker_called)

    def test_real_mode_refuses_another_card_and_a_tenant_off_this_machine(self) -> None:
        card, called = self.run_gate(env={**REAL_ENV, "CSP_STRIPE_TEST_CARD": "4000 0000 0000 0002"})
        self.assertEqual(card.returncode, 2, card.stderr)
        self.assertIn("CSP_STRIPE_TEST_CARD", card.stderr)
        self.assertFalse(called)
        port, called = self.run_gate(env={**REAL_ENV, "CSP_CHECKOUT_PORT": "4321@tenant.example.com"})
        self.assertEqual(port.returncode, 2, port.stderr)
        self.assertIn("local disposable tenant", port.stderr)
        self.assertFalse(called)

    def test_a_switch_other_than_one_and_derive_in_real_mode_are_refused(self) -> None:
        wrong, called = self.run_gate(env={**REAL_ENV, "CSP_STRIPE_REAL_TEST_MODE": "yes"})
        self.assertEqual(wrong.returncode, 2)
        self.assertIn("CSP_STRIPE_REAL_TEST_MODE must be 1", wrong.stderr)
        self.assertFalse(called)
        derive, called = self.run_gate("--derive", env={**REAL_ENV, "CSP_STRIPE_REAL_JS": "1"})
        self.assertEqual(derive.returncode, 2)
        self.assertIn("--derive", derive.stderr)
        self.assertFalse(called)

    def test_help_prints_the_owner_command_and_exits_zero_without_docker(self) -> None:
        done, docker_called = self.run_gate("--help", env={})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("CSP_STRIPE_REAL_TEST_MODE=1 csp/gate/csp-checkout-gate.py", done.stdout)
        self.assertIn("stripe listen --forward-to http://localhost:4321/members/webhooks/stripe/", done.stdout)
        self.assertFalse(docker_called)

    def test_without_the_switch_test_keys_in_the_environment_are_not_a_real_run(self) -> None:
        live = made_up("sk_live", "LiveSecretMarker")
        done, _ = self.run_gate(env={**OWNER_KEYS, "STRIPE_TEST_SECRET_KEY": live})
        self.assertNotEqual(done.returncode, 0)  # stopped by the shim docker or a missing build
        self.assertNotRegex(self.seen(done), r"REAL TEST MODE|STRIPE_TEST_|real test mode")
        for marker in (*MARKERS, "LiveSecretMarker"):
            self.assertNotIn(marker, self.seen(done))


# (name, text to replace in the real source, replacement, a test that must go red)
MUTATIONS = [
    (
        "refusal exit code 2 -> 1",
        "EXIT_REFUSED = 2",
        "EXIT_REFUSED = 1",
        "test_an_unknown_sabotage_exits_two",
    ),
    (
        "derive allowed without the real Stripe.js",
        'self.deps.environ.get(REAL_JS_ENV, "") != "1"',
        "False",
        "test_derive_needs_the_real_stripe_js",
    ),
    (
        "unbuilt render-core not refused",
        'if not (self.deps.repo_root / "render-core" / "dist" / "index.js").is_file():',
        "if False:",
        "test_an_unbuilt_render_core_is_refused",
    ),
    (
        "enforcing check skipped",
        'if cut_field(rendered, 1) != "enforcing":',
        "if False:",
        "test_a_policy_that_is_not_enforcing_is_refused",
    ),
    (
        "verdict exit code dropped",
        "        return status",
        "        return 0",
        "test_the_verdict_steps_exit_code",
    ),
    (
        "sabotage keeps the allowance",
        'payments = "none" if sabotage == SABOTAGE_NO_STRIPE_ORIGIN else "stripe"',
        'payments = "stripe"',
        "test_the_sabotage_serves_the_policy_without",
    ),
    (
        "cleanup skipped",
        "            self.cleanup()",
        "            pass",
        "test_cleanup_removes_the_containers",
    ),
    (
        "derive served enforcing",
        "self.start_origin(REPORT_ONLY_HEADER, none_value)",
        "self.start_origin(ENFORCING_HEADER, none_value)",
        "test_derive_serves_the_strict_policy_report_only",
    ),
    (
        "a live key shape",
        'f"sk_test_{self.deps.token()}"',
        'f"sk_live_{self.deps.token()}"',
        "test_the_setup_steps_get_the",
    ),
    (
        "a failed step is swallowed",
        "raise GateError(result.returncode)",
        "return result",
        "test_a_failed_setup_step_ends_the_run",
    ),
    (
        "given image ignored",
        "            image = arg",
        "            pass",
        "test_a_given_image_is_used",
    ),
    (
        "probe timeout exits 1",
        'raise GateError(EXIT_REFUSED, f"FAILED: {description}',
        'raise GateError(1, f"FAILED: {description}',
        "test_a_probe_that_never_succeeds",
    ),
    (
        "derive check exit code dropped",
        "        return self.execute(check).returncode",
        "        self.execute(check)\n        return 0",
        "test_derives_exit_code_is_the_checks_exit_code",
    ),
    (
        "any value of the real switch accepted",
        'if switch not in ("", "1"):',
        "if False:",
        "test_a_switch_value_other_than_one_is_refused",
    ),
    (
        "real mode allowed with derive",
        "if self.real and self.options.derive:",
        "if False:",
        "test_real_mode_refuses_derive",
    ),
    (
        "preflight skipped",
        "if not checked.ok:",
        "if False:",
        "test_a_failed_preflight_exits_two",
    ),
    (
        "preflight refusal exits 1",
        'raise GateError(EXIT_REFUSED, "\\n".join(checked.lines))',
        'raise GateError(1, "\\n".join(checked.lines))',
        "test_a_failed_preflight_exits_two",
    ),
    (
        "preflight refusal not printed",
        'raise GateError(EXIT_REFUSED, "\\n".join(checked.lines))',
        "raise GateError(EXIT_REFUSED)",
        "test_a_failed_preflight_exits_two",
    ),
    (
        "preflight not given the origin",
        "real_test_mode.preflight(self.deps.environ, self.origin)",
        'real_test_mode.preflight(self.deps.environ, "http://localhost:4321")',
        "test_the_preflight_judges_this_runs_origin",
    ),
    (
        "preflight not given the environment",
        "real_test_mode.preflight(self.deps.environ, self.origin)",
        "real_test_mode.preflight({}, self.origin)",
        "test_a_failed_preflight_exits_two",
    ),
    (
        "preflight accepted lines not printed",
        "            for line in checked.lines:\n                self.say(line)\n",
        "",
        "test_the_preflight_judges_this_runs_origin",
    ),
    (
        "help not printed",
        "self.say(real_test_mode.usage())",
        "pass",
        "test_help_prints_the_modules_usage",
    ),
    (
        "fake still started in real mode",
        "if not self.real:\n            self.start_fake_stripe",
        "if True:\n            self.start_fake_stripe",
        "test_a_real_run_preflights_first_and_starts_no_fake",
    ),
    (
        "fake still waited for in real mode",
        "if not self.real:\n            self.wait_for(",
        "if True:\n            self.wait_for(",
        "test_a_real_run_preflights_first_and_starts_no_fake",
    ),
    (
        "owner secret key not used",
        "stripe_secret = self.required_env(REAL_SECRET_KEY_ENV)",
        'stripe_secret = f"sk_test_{self.deps.token()}"',
        "test_real_keys_reach_the_setup_step",
    ),
    (
        "owner webhook secret not used",
        "webhook_secret = self.required_env(REAL_WEBHOOK_SECRET_ENV)",
        'webhook_secret = f"whsec_{self.deps.token()}"',
        "test_real_ghost_has_no_fake",
    ),
    (
        "webhook secret in the docker argument list",
        'extra = (*env_flags(["stripeDirect=true"]), "-e", WEBHOOK_SECRET_ENV)',
        'extra = env_flags(["stripeDirect=true", f"{WEBHOOK_SECRET_ENV}={webhook_secret}"])',
        "test_real_ghost_has_no_fake",
    ),
    (
        "webhook secret not carried in the environment",
        "env={WEBHOOK_SECRET_ENV: webhook_secret}",
        "env={}",
        "test_real_ghost_has_no_fake",
    ),
    (
        "real flag not passed to node steps",
        'marked = {**env, REAL_MODE_PROOF_FLAG: "1"} if self.real else env',
        "marked = env",
        "test_real_keys_reach_the_setup_step",
    ),
    (
        "real flag passed in the default run",
        'marked = {**env, REAL_MODE_PROOF_FLAG: "1"} if self.real else env',
        'marked = {**env, REAL_MODE_PROOF_FLAG: "1"}',
        "test_without_the_switch_the_owner_variables",
    ),
    (
        "cleanup keeps the volumes",
        'self.silently("docker", "rm", "-fv", *containers)',
        'self.silently("docker", "rm", "-f", *containers)',
        "test_every_removal_takes_the_anonymous_volumes",
    ),
    (
        "origin restart keeps the volumes",
        'self.silently("docker", "rm", "-fv", self.origin_name)',
        'self.silently("docker", "rm", "-f", self.origin_name)',
        "test_every_removal_takes_the_anonymous_volumes",
    ),
    (
        "stderr of a real run not taken in",
        'errors: Stderr = "capture" if self.real else "inherit"',
        'errors: Stderr = "inherit"',
        "test_real_mode_takes_every_node_steps_stderr_in",
    ),
    (
        "stderr of a default run taken in",
        'errors: Stderr = "capture" if self.real else "inherit"',
        'errors: Stderr = "capture"',
        "test_real_mode_takes_every_node_steps_stderr_in",
    ),
    (
        "stderr printed without redaction",
        "shown = real_test_mode.redact_secrets(result.stderr, self.secrets())",
        "shown = result.stderr",
        "test_what_a_node_step_says_on_stderr_is_printed_with_every_secret_redacted",
    ),
    (
        "stderr dropped",
        'if command.stderr == "capture" and result.stderr:',
        "if False:",
        "test_what_a_node_step_says_on_stderr_is_printed_with_every_secret_redacted",
    ),
    (
        "a real capture not scrubbed",
        "            return real_test_mode.scrub_capture(run_json, self.origin, self.secrets())\n",
        "            return run_json\n",
        "test_a_real_capture_is_redacted",
    ),
    (
        "a default capture scrubbed",
        "        if self.real:\n            # Redacted, and Stripe's own",
        "        if True:\n            # Redacted, and Stripe's own",
        "test_a_default_capture_is_passed_to_the_judge_untouched",
    ),
    (
        "a command shows its environment when printed",
        "field(default_factory=dict, repr=False)",
        "field(default_factory=dict)",
        "test_a_command_never_shows_its_environment",
    ),
    (
        "a missing owner key passes as empty",
        "        if not value:\n            raise GateError(EXIT_REFUSED, f\"{name} is not set\")",
        "        if False:\n            raise GateError(EXIT_REFUSED, f\"{name} is not set\")",
        "test_a_missing_owner_key_after_preflight",
    ),
]


class SabotageProof(unittest.TestCase):
    """Break the real source one rule at a time: the tests above must go red."""

    def mutated(self, old: str, new: str) -> ModuleType:
        source = SOURCE.read_text()
        self.assertIn(
            old, source, "sabotage target not found: a mutation that changed nothing proves nothing"
        )
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "mutated_gate.py"
        path.write_text(source.replace(old, new, 1))
        return load(path, f"csp_checkout_gate_mutated_{abs(hash(old))}")

    def failing_tests(self, module: ModuleType) -> list[str]:
        suite_class = type(
            "MutatedBehaviour", (BehaviourTests, unittest.TestCase), {"gate": module}
        )
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
