#!/usr/bin/env python3
"""The checkout half of the content-policy gate, live.

Usage:
    csp-checkout-gate.py [--sabotage=no-stripe-origin] [--derive] [--help] [IMAGE]

A real headless Chromium takes a member through the paid upgrade and the return
from checkout on a real Ghost behind the edge policy, with a fake Stripe API
standing in for the service. The exit code is the verdict of the step that
judged the run (0 green, 1 red); 2 is a refusal before or during setup, and a
setup command that fails ends the run with its own exit code.
With CSP_STRIPE_REAL_TEST_MODE=1 the owner's own Stripe TEST-mode keys replace the
fake Stripe (see the .md). Those keys live only in this process's environment:
they reach a child through its environment, never through an argument or a line
printed here, and the run never writes them anywhere.
See csp/gate/csp-checkout-gate.md for the modes and what it does NOT prove.
"""

from __future__ import annotations

import os
import secrets
import shlex
import signal
import string
import subprocess
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, TextIO

EXIT_REFUSED = 2
EXIT_NOT_FOUND = 127
EXIT_INTERRUPTED = 130
EXIT_TERMINATED = 143

SABOTAGE_NO_STRIPE_ORIGIN = "no-stripe-origin"
REAL_JS_ENV = "CSP_STRIPE_REAL_JS"
REAL_MODE_ENV = "CSP_STRIPE_REAL_TEST_MODE"
REAL_MODE_PROOF_FLAG = "PROOF_REAL_TEST_MODE"
REAL_MODE_MODULE = "csp/proof/real-test-mode.mjs"
REAL_SECRET_KEY_ENV = "STRIPE_TEST_SECRET_KEY"
REAL_PUBLISHABLE_KEY_ENV = "STRIPE_TEST_PUBLISHABLE_KEY"
REAL_WEBHOOK_SECRET_ENV = "STRIPE_TEST_WEBHOOK_SECRET"
WEBHOOK_SECRET_ENV = "WEBHOOK_SECRET"
DEFAULT_GHOST_IMAGE = "csp-gate-ghost:local"
ORIGIN_IMAGE = "csp-gate-origin:local"
GATE_MARKER_HEADER = "X-Csp-Gate-Marker"
ENFORCING_HEADER = "Content-Security-Policy"
REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only"
DEFAULT_HOST_PORT = "4321"
DEFAULT_STRIPE_PORT = "4322"
FAKE_STRIPE_CONTAINER_PORT = 12111
GHOST_PORT = 2368
KEY_ALPHABET = string.ascii_letters + string.digits
KEY_LENGTH = 24

Stdout = Literal["inherit", "capture", "discard"]
Stderr = Literal["inherit", "discard"]


@dataclass(frozen=True)
class Command:
    """One program to run: argv (never a shell string), extra env, streams."""

    argv: tuple[str, ...]
    env: Mapping[str, str] = field(default_factory=dict, repr=False)  # may carry keys
    stdin: str | None = None
    stdout: Stdout = "inherit"
    stderr: Stderr = "inherit"


@dataclass(frozen=True)
class Result:
    returncode: int
    stdout: str = ""


Runner = Callable[[Command], Result]


class GateError(Exception):
    """End the run with this exit code, after the cleanup, printing the message."""

    def __init__(self, code: int, message: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Options:
    sabotage: str
    derive: bool
    image: str
    help: bool = False


@dataclass
class Deps:
    """Everything the run touches outside itself, so tests can replace it."""

    repo_root: Path
    environ: Mapping[str, str]
    run: Runner
    now: Callable[[], int]
    sleep: Callable[[float], None]
    pid: int
    token: Callable[[], str]
    out: TextIO
    err: TextIO


def run_subprocess(repo_root: Path) -> Runner:
    """The real runner: argv list, no shell, working directory the repo root."""
    streams: dict[Stdout, int | None] = {
        "inherit": None,
        "capture": subprocess.PIPE,
        "discard": subprocess.DEVNULL,
    }

    def run(command: Command) -> Result:
        try:
            done = subprocess.run(  # noqa: S603 - argv list, fixed programs, no shell
                command.argv,
                cwd=repo_root,
                env={**os.environ, **command.env},
                input=command.stdin,
                stdout=streams[command.stdout],
                stderr=subprocess.DEVNULL if command.stderr == "discard" else None,
                encoding="utf-8",
                check=False,
            )
        except FileNotFoundError:
            if command.stderr == "inherit":
                print(f"{command.argv[0]}: command not found", file=sys.stderr)
            return Result(EXIT_NOT_FOUND)
        return Result(done.returncode, done.stdout or "")

    return run


def parse_args(argv: Sequence[str]) -> Options:
    """Read the command line the way the shell script's `case` did.

    Raises:
        GateError: an unknown `--sabotage=` mode (exit 2).
    """
    sabotage = ""
    derive = False
    help_requested = False
    image = ""
    for arg in argv:
        if arg == f"--sabotage={SABOTAGE_NO_STRIPE_ORIGIN}":
            sabotage = SABOTAGE_NO_STRIPE_ORIGIN
        elif arg.startswith("--sabotage="):
            raise GateError(EXIT_REFUSED, f"unknown sabotage: {arg}")
        elif arg == "--derive":
            derive = True
        elif arg in ("--help", "-h"):
            help_requested = True
        else:
            image = arg
    return Options(sabotage=sabotage, derive=derive, image=image, help=help_requested)


def cut_field(text: str, number: int) -> str:
    """`cut -f<number>` on tab-separated lines: a line with no tab passes whole."""
    lines = []
    for line in text.split("\n"):
        parts = line.split("\t")
        if len(parts) == 1:
            lines.append(line)
        else:
            lines.append(parts[number - 1] if number <= len(parts) else "")
    return "\n".join(lines).rstrip("\n")


def parse_assignments(text: str) -> dict[str, str]:
    """The KEY=value lines setup-content prints, read the way `eval` reads them."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        try:
            words = shlex.split(line)
        except ValueError:
            continue
        if len(words) == 1 and "=" in words[0]:
            key, _, value = words[0].partition("=")
            values[key] = value
    return values


def env_flags(settings: Sequence[str]) -> list[str]:
    """`-e KEY=value` for each setting."""
    return [part for setting in settings for part in ("-e", setting)]


def ghost_run_args(
    name: str, network: str, origin: str, image: str, extra: Sequence[str] = ()
) -> tuple[str, ...]:
    """The pinned Ghost under test, as `docker run` arguments: sqlite, local scanning
    storage, self-hosted widget bundles, then `extra` settings, then the image."""
    settings = [
        f"url={origin}",
        "database__client=sqlite3",
        "database__connection__filename=/var/lib/ghost/content/data/ghost-csp-gate.db",
        "privacy__useUpdateCheck=false",
        "BRANCHLEFT_ALLOW_LOCAL_STORAGE=true",
        "storage__images__adapter=ScanningStorageAdapter",
        "storage__images__wraps=LocalImagesStorage",
        "storage__images__quarantinePath=/var/lib/ghost/content/quarantine",
        "storage__media__adapter=ScanningStorageAdapter",
        "storage__media__wraps=LocalMediaStorage",
        "storage__media__quarantinePath=/var/lib/ghost/content/quarantine",
        "storage__files__adapter=ScanningStorageAdapter",
        "storage__files__wraps=LocalFilesStorage",
        "storage__files__quarantinePath=/var/lib/ghost/content/quarantine",
        "storage__images__verdictSource=in-process-fake",
        "storage__media__verdictSource=in-process-fake",
        "storage__files__verdictSource=in-process-fake",
        'logging__transports=["stdout"]',
        f"portal__url={origin}/bl-assets/portal.min.js",
        f"sodoSearch__url={origin}/bl-assets/sodo-search.min.js",
        f"sodoSearch__styles={origin}/bl-assets/sodo-search.min.css",
    ]
    head = ["docker", "run", "-d", "--name", name, "--network", network]
    return (*head, *env_flags(settings), *extra, image)


def env_or_default(environ: Mapping[str, str], name: str, default: str) -> str:
    """`${NAME:-default}`: an empty value counts as unset."""
    return environ.get(name) or default


class Gate:
    def __init__(self, deps: Deps, options: Options) -> None:
        self.deps = deps
        self.options = options
        pid = deps.pid
        self.net = f"csp-checkout-net-{pid}"
        self.ghost_name = f"csp-checkout-ghost-{pid}"
        self.origin_name = f"csp-checkout-origin-{pid}"
        self.fake_name = f"csp-checkout-stripe-{pid}"
        self.host_port = env_or_default(deps.environ, "CSP_CHECKOUT_PORT", DEFAULT_HOST_PORT)
        self.stripe_port = env_or_default(
            deps.environ, "CSP_CHECKOUT_STRIPE_PORT", DEFAULT_STRIPE_PORT
        )
        self.origin = f"http://localhost:{self.host_port}"
        self.stripe_url = f"http://localhost:{self.stripe_port}"
        self.real = False

    def run(self) -> int:
        """Refuse what cannot run, then run the gate and always clean up.

        Raises:
            GateError: a refusal (exit 2) or a failed setup step (its exit code).
        """
        # The opt-in real Stripe TEST-mode switch (csp-checkout-gate.md). Every refusal
        # about the keys lives in real-test-mode.mjs; with the switch unset nothing
        # below is read and the fake Stripe runs exactly as before.
        switch = self.deps.environ.get(REAL_MODE_ENV, "")
        if switch not in ("", "1"):
            raise GateError(EXIT_REFUSED, f"{REAL_MODE_ENV} must be 1 (or unset for the fake Stripe)")
        self.real = switch == "1"
        if self.options.help:
            self.deps.run(Command(("node", REAL_MODE_MODULE, "help")))
            return 0
        if self.real and self.options.derive:
            raise GateError(
                EXIT_REFUSED,
                "--derive needs no keys and measures the real Stripe.js: "
                f"run it without {REAL_MODE_ENV}",
            )
        if self.real:
            # Before anything starts: the keys' shapes, a local tenant, the test card.
            preflight = Command(("node", REAL_MODE_MODULE, "preflight", "--origin", self.origin))
            if self.deps.run(preflight).returncode != 0:
                raise GateError(EXIT_REFUSED)
        if self.options.derive and self.deps.environ.get(REAL_JS_ENV, "") != "1":
            raise GateError(
                EXIT_REFUSED,
                "--derive measures the origins the REAL Stripe.js needs: "
                f"run it with {REAL_JS_ENV}=1",
            )
        if not (self.deps.repo_root / "render-core" / "dist" / "index.js").is_file():
            raise GateError(
                EXIT_REFUSED,
                "render-core is not built: the policy is rendered through its built "
                "output (cd render-core && pnpm run build)",
            )
        try:
            return self.gate()
        finally:
            self.cleanup()

    def cleanup(self) -> None:
        containers = (self.ghost_name, self.origin_name, self.fake_name)
        # -v also removes each container's anonymous volumes: Ghost's image declares a
        # content volume, and in real mode it holds the owner's test keys.
        self.silently("docker", "rm", "-fv", *containers)
        self.silently("docker", "network", "rm", self.net)

    def silently(self, *argv: str) -> None:
        """Run a step whose output and failure are both ignored (`>/dev/null 2>&1 || true`)."""
        self.deps.run(Command(argv, stdout="discard", stderr="discard"))

    def check(self, command: Command) -> Result:
        """Run a step whose failure ends the run with its own exit code.

        Raises:
            GateError: the step exited non-zero, carrying its exit code.
        """
        result = self.deps.run(command)
        if result.returncode != 0:
            raise GateError(result.returncode)
        return result

    def docker(self, *argv: str, env: Mapping[str, str] | None = None) -> None:
        """A docker step with its stdout discarded, which must succeed."""
        self.check(Command(("docker", *argv), env=env or {}, stdout="discard"))

    def node(
        self,
        script: str,
        env: Mapping[str, str],
        *,
        stdin: str | None = None,
        stdout: Stdout = "capture",
        args: Sequence[str] = (),
    ) -> Command:
        # Real mode tells every node step so (the capture and the setup read it).
        marked = {**env, REAL_MODE_PROOF_FLAG: "1"} if self.real else env
        return Command(("node", f"csp/{script}", *args), env=marked, stdin=stdin, stdout=stdout)

    def say(self, line: str) -> None:
        print(line, file=self.deps.out, flush=True)

    def wait_for(self, description: str, seconds: int, argv: Sequence[str]) -> None:
        """Retry a probe once a second until it succeeds or the deadline passes.

        Raises:
            GateError: the probe never succeeded in time (exit 2).
        """
        deadline = self.deps.now() + seconds
        while self.deps.run(Command(tuple(argv), stderr="discard")).returncode != 0:
            if self.deps.now() >= deadline:
                raise GateError(EXIT_REFUSED, f"FAILED: {description} not ready within {seconds}s")
            self.deps.sleep(1)

    def start_origin(self, header_name: str, header_value: str) -> None:
        self.silently("docker", "rm", "-fv", self.origin_name)
        settings = [
            f"GHOST_UPSTREAM={self.ghost_name}:{GHOST_PORT}",
            f"CSP_HEADER_NAME={header_name}",
            f"CSP_HEADER_VALUE={header_value}",
        ]
        self.docker(
            *("run", "-d", "--name", self.origin_name, "--network", self.net),
            *("-p", f"{self.host_port}:8080"),
            *env_flags(settings),
            ORIGIN_IMAGE,
        )
        self.wait_for("origin", 30, ("curl", "-sf", "-o", "/dev/null", f"{self.origin}/"))

    def start_fake_stripe(self, image: str, webhook_secret: str) -> None:
        proof_dir = self.deps.repo_root / "csp" / "proof"
        settings = [
            f"FAKE_STRIPE_PUBLIC_URL={self.stripe_url}",
            f"FAKE_STRIPE_WEBHOOK_URL=http://{self.ghost_name}:{GHOST_PORT}/members/webhooks/stripe/",
            f"FAKE_STRIPE_WEBHOOK_SECRET={webhook_secret}",
        ]
        self.docker(
            *("run", "-d", "--name", self.fake_name, "--network", self.net),
            *("-p", f"127.0.0.1:{self.stripe_port}:{FAKE_STRIPE_CONTAINER_PORT}"),
            *("-v", f"{proof_dir}:/proof:ro"),
            *env_flags(settings),
            *("--entrypoint", "node", image, "/proof/fake-stripe.mjs"),
        )

    def start_ghost(self, image: str, webhook_secret: str) -> None:
        if self.real:
            self.start_real_ghost(image, webhook_secret)
            return
        # stripeDirect makes Ghost use the keys set through its settings; STRIPE_API_*
        # point its Stripe client at the fake; WEBHOOK_SECRET puts the webhook manager
        # in its "local" mode, verifying the fake's signatures with a secret we hold.
        extra = env_flags(
            [
                "stripeDirect=true",
                f"STRIPE_API_HOST={self.fake_name}",
                f"STRIPE_API_PORT={FAKE_STRIPE_CONTAINER_PORT}",
                "STRIPE_API_PROTOCOL=http",
                f"WEBHOOK_SECRET={webhook_secret}",
            ]
        )
        args = ghost_run_args(self.ghost_name, self.net, self.origin, image, extra)
        self.docker(*args[1:])
        self.wait_for_ghost()

    def start_real_ghost(self, image: str, webhook_secret: str) -> None:
        """Ghost against Stripe's own API: no fake, so no STRIPE_API_* settings. The
        webhook secret is passed by name (`-e WEBHOOK_SECRET`), its value carried only
        in the child's environment, so it is in no argument list."""
        extra = (*env_flags(["stripeDirect=true"]), "-e", WEBHOOK_SECRET_ENV)
        args = ghost_run_args(self.ghost_name, self.net, self.origin, image, extra)
        self.docker(*args[1:], env={WEBHOOK_SECRET_ENV: webhook_secret})
        self.wait_for_ghost()

    def wait_for_ghost(self) -> None:
        ready = ("docker", "exec", self.ghost_name, "wget", "-q", "-O", "/dev/null")
        self.wait_for("Ghost", 90, (*ready, f"http://127.0.0.1:{GHOST_PORT}/"))

    def render_policy(self, payments: str, hashes_json: str) -> Result:
        env = {"CSP_PAYMENTS": payments}
        return self.deps.run(self.node("proof/render-header.mjs", env, stdin=hashes_json))

    def capture(self, label: str, session_cookie: str) -> str:
        env = {
            "PROOF_ORIGIN": self.origin,
            "PROOF_LABEL": label,
            "PROOF_SESSION_COOKIE": session_cookie,
            "PROOF_STRIPE_URL": self.stripe_url,
        }
        return self.check(self.node("proof/capture-checkout.mjs", env)).stdout.rstrip("\n")

    def required_env(self, name: str) -> str:
        """An owner-supplied value, which preflight has already checked.

        Raises:
            GateError: the variable is unset (exit 2); the message never carries a value.
        """
        value = self.deps.environ.get(name, "")
        if not value:
            raise GateError(EXIT_REFUSED, f"{name} is not set")
        return value

    def gate(self) -> int:
        image = self.options.image
        if self.real:
            # TEST MODE ONLY, the owner's own: read here, passed on only in a child's
            # environment, never an argument, never printed.
            stripe_secret = self.required_env(REAL_SECRET_KEY_ENV)
            stripe_publishable = self.required_env(REAL_PUBLISHABLE_KEY_ENV)
            webhook_secret = self.required_env(REAL_WEBHOOK_SECRET_ENV)
        else:
            # TEST MODE ONLY, synthetic and per run: Ghost checks only the shape, and
            # the Stripe it reaches is the fake, which refuses any key that is not sk_test_.
            stripe_secret = f"sk_test_{self.deps.token()}"
            stripe_publishable = f"pk_test_{self.deps.token()}"
            webhook_secret = f"whsec_{self.deps.token()}"

        if not image:
            image = DEFAULT_GHOST_IMAGE
            self.docker("build", "-q", "-t", image, ".")
        self.docker("build", "-q", "-f", "csp/proof/Dockerfile", "-t", ORIGIN_IMAGE, ".")
        self.docker("network", "create", self.net)
        if not self.real:
            self.start_fake_stripe(image, webhook_secret)
        self.start_ghost(image, webhook_secret)
        self.start_origin(GATE_MARKER_HEADER, "none")
        if not self.real:
            self.wait_for(
                "fake Stripe", 30, ("curl", "-sf", "-o", "/dev/null", f"{self.stripe_url}/__state")
            )

        # setup-content's own exit status is not checked: the shell `eval "$(...)"`
        # never saw it, and a failure here shows as the next step failing.
        content_run = self.deps.run(
            self.node("proof/setup-content.mjs", {"PROOF_ORIGIN": self.origin})
        )
        content = parse_assignments(content_run.stdout)
        session_cookie = content.get("SESSION_COOKIE", "")
        paid_env = {
            "PROOF_ORIGIN": self.origin,
            "PROOF_SESSION_COOKIE": session_cookie,
            "PROOF_STRIPE_SECRET_KEY": stripe_secret,
            "PROOF_STRIPE_PUBLISHABLE_KEY": stripe_publishable,
        }
        self.check(self.node("proof/setup-paid.mjs", paid_env, stdout="discard"))

        # The theme's own script hashes, from the CLEAN pages of the paid-enabled site
        # (the Stripe tag has a src, so it is not hashed: the hashes are unchanged).
        paths = ",".join(
            [
                "/",
                f"/{content.get('POST_SLUG', '')}/",
                f"/tag/{content.get('TAG_SLUG', '')}/",
                f"/author/{content.get('AUTHOR_SLUG', '')}/",
            ]
        )
        hashes_env = {"GHOST_ORIGIN": self.origin, "CSP_DERIVE_PATHS": paths}
        hashes = self.check(self.node("derive/derive-script-hashes.mjs", hashes_env))
        hashes_json = hashes.stdout.rstrip("\n")

        if self.options.derive:
            return self.derive(hashes_json, session_cookie)
        return self.enforce(hashes_json, session_cookie)

    def derive(self, hashes_json: str, session_cookie: str) -> int:
        """Measure, not judge: the strict policy with no allowance, served report-only
        so nothing hides behind the first block, against the real Stripe.js. The
        renderer's own exit status is not checked (the shell `render | cut` pipeline
        never saw it); what it printed is."""
        none_value = cut_field(self.render_policy("none", hashes_json).stdout, 2)
        self.start_origin(REPORT_ONLY_HEADER, none_value)
        run_json = self.capture("derive", session_cookie)
        self.say(run_json)
        check = self.node(
            "derive/derive-payment-origins.mjs",
            {},
            stdin=run_json,
            stdout="inherit",
            args=("--check",),
        )
        return self.deps.run(check).returncode

    def enforce(self, hashes_json: str, session_cookie: str) -> int:
        """Gate: the ENFORCING policy under test. The sabotage serves the same Ghost
        with the payments allowance removed, which must go red naming the Stripe origin.

        Raises:
            GateError: the renderer failed, or did not render an enforcing policy.
        """
        sabotage = self.options.sabotage
        payments = "none" if sabotage == SABOTAGE_NO_STRIPE_ORIGIN else "stripe"
        rendering = self.render_policy(payments, hashes_json)
        if rendering.returncode != 0:
            raise GateError(rendering.returncode)
        rendered = rendering.stdout.rstrip("\n")
        if cut_field(rendered, 1) != "enforcing":
            raise GateError(
                EXIT_REFUSED,
                "FAILED: the policy under test is not enforcing (no theme hashes derived?)",
            )
        policy_value = cut_field(rendered, 2)
        self.say(f"POLICY {sabotage or 'payments=stripe'}: {policy_value}")

        started = self.deps.now()
        self.start_origin(ENFORCING_HEADER, policy_value)
        run_json = self.capture(f"checkout-{sabotage}" if sabotage else "checkout", session_cookie)
        self.say(run_json)
        judge = self.node("gate/checkout-gate.mjs", {}, stdin=run_json, stdout="inherit")
        status = self.deps.run(judge).returncode
        elapsed = self.deps.now() - started
        self.say(f"GATE_TIMING seconds={elapsed} sabotage={sabotage or 'none'} exit={status}")
        return status


def random_key() -> str:
    return "".join(secrets.choice(KEY_ALPHABET) for _ in range(KEY_LENGTH))


def main(argv: Sequence[str], deps: Deps) -> int:
    """Run the gate and return the process exit code."""
    try:
        return Gate(deps, parse_args(argv)).run()
    except GateError as stop:
        if stop.message:
            print(stop.message, file=deps.err)
        return stop.code


def terminate(_signum: int, _frame: object) -> None:
    raise SystemExit(EXIT_TERMINATED)


if __name__ == "__main__":
    root = Path(os.path.abspath(__file__)).parents[2]
    signal.signal(signal.SIGTERM, terminate)
    try:
        code = main(
            sys.argv[1:],
            Deps(
                repo_root=root,
                environ=os.environ,
                run=run_subprocess(root),
                now=lambda: int(time.time()),
                sleep=time.sleep,
                pid=os.getpid(),
                token=random_key,
                out=sys.stdout,
                err=sys.stderr,
            ),
        )
    except KeyboardInterrupt:
        code = EXIT_INTERRUPTED
    raise SystemExit(code)
