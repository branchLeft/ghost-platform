#!/usr/bin/env python3
"""The magic-link half of the content-policy gate, live.

Usage:
    magic_link_gate.py [--sabotage=MODE] [--help] [IMAGE]

A disposable tenant on Docker: the pinned Ghost under the strict policy
render-core renders, a mail spool in place of any real mail path (the tenant's
SMTP goes to it and nothing leaves the Docker network), and a real headless
Chromium that signs a reader up through Portal, reads the magic link out of the
spool, follows it and signs in. Green only when the browser reports zero
content-policy violations (magic_link_verdict.py). The exit code is the verdict
(0 green, 1 red); 2 is a refusal before or during setup, and a setup command that
fails ends the run with its own exit code.

Each --sabotage mode breaks one thing the page needs and must exit 1, so a pass is
known to be able to fail. See csp/gate/csp-magic-link-gate.md for the modes and
for what this does NOT prove.
"""

from __future__ import annotations

import os
import re
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

import magic_link_verdict

EXIT_REFUSED = 2
EXIT_NOT_FOUND = 127
EXIT_INTERRUPTED = 130
EXIT_TERMINATED = 143

# Each mode breaks one thing the sign-up page and the mailed link need, and names
# where it is broken. See the .md for what each is the stand-in for.
SABOTAGE_NO_INLINE_STYLE = "no-inline-style"
SABOTAGE_NO_SELF_SCRIPT = "no-self-script"
SABOTAGE_PORTAL_ON_CDN = "portal-on-cdn"
SABOTAGES = (SABOTAGE_NO_INLINE_STYLE, SABOTAGE_NO_SELF_SCRIPT, SABOTAGE_PORTAL_ON_CDN)

DEFAULT_GHOST_IMAGE = "csp-magic-link-ghost:local"
ORIGIN_IMAGE = "csp-magic-link-origin:local"
SPOOL_IMAGE = "csp-magic-link-spool:local"
SPOOL_BUILD_CONTEXT = "scripts/mail-gate/spool-standin"
SPOOL_IMAGE_ENV = "CSP_MAGIC_LINK_SPOOL_IMAGE"
GATE_MARKER_HEADER = "X-Csp-Gate-Marker"
ENFORCING_HEADER = "Content-Security-Policy"
DEFAULT_HOST_PORT = "4331"
DEFAULT_DRAIN_PORT = "4332"
GHOST_PORT = 2368
SMTP_PORT = "2525"
# The spool's drain listener binds one address, as the shim's does in production, so
# its network has a fixed subnet. Not the mail gate's (10.231.202.0/29) nor the
# production hosts' range: two gates never share an address range.
SPOOL_SUBNET = "10.231.203.0/28"
SPOOL_ADDRESS = "10.231.203.2"
SPOOL_ALIAS = "mail-spool"
SENDER_DOMAIN = "magic-link.csp-gate.test"
MEMBER_EMAIL = "magic-link-member@example.test"
KEY_ALPHABET = string.ascii_letters + string.digits
KEY_LENGTH = 24

Stdout = Literal["inherit", "capture", "discard"]
Stderr = Literal["inherit", "capture", "discard"]


@dataclass(frozen=True)
class Command:
    """One program to run: argv (never a shell string), extra env, streams."""

    argv: tuple[str, ...]
    env: Mapping[str, str] = field(default_factory=dict, repr=False)  # may carry the spool key
    stdin: str | None = None
    stdout: Stdout = "inherit"
    stderr: Stderr = "inherit"


@dataclass(frozen=True)
class Result:
    returncode: int
    stdout: str = ""
    stderr: str = ""


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
    streams: dict[str, int | None] = {
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
                stderr=streams[command.stderr],
                encoding="utf-8",
                check=False,
            )
        except FileNotFoundError:
            message = f"{command.argv[0]}: command not found"
            if command.stderr == "inherit":
                print(message, file=sys.stderr)
            return Result(EXIT_NOT_FOUND, stderr=message + "\n" if command.stderr == "capture" else "")
        return Result(done.returncode, done.stdout or "", done.stderr or "")

    return run


def parse_args(argv: Sequence[str]) -> Options:
    """Read the command line.

    Raises:
        GateError: an unknown `--sabotage=` mode (exit 2).
    """
    sabotage = ""
    image = ""
    help_requested = False
    for arg in argv:
        if arg.startswith("--sabotage="):
            mode = arg.removeprefix("--sabotage=")
            if mode not in SABOTAGES:
                raise GateError(EXIT_REFUSED, f"unknown sabotage: {arg} (one of {', '.join(SABOTAGES)})")
            sabotage = mode
        elif arg in ("--help", "-h"):
            help_requested = True
        else:
            image = arg
    return Options(sabotage=sabotage, image=image, help=help_requested)


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


def sabotage_policy(policy: str, mode: str) -> str:
    """The rendered policy with one source the page needs taken out.

    Raises:
        GateError: the policy has no such source to take out (exit 2), so a
            sabotage can never pass by changing nothing.
    """
    if mode == SABOTAGE_NO_INLINE_STYLE:
        broken = re.sub(r"(style-src[^;]*?)\s*'unsafe-inline'", r"\1", policy)
    elif mode == SABOTAGE_NO_SELF_SCRIPT:
        broken = re.sub(r"(script-src)\s+'self'", r"\1", policy)
    else:
        broken = policy
    if broken == policy and mode in (SABOTAGE_NO_INLINE_STYLE, SABOTAGE_NO_SELF_SCRIPT):
        raise GateError(EXIT_REFUSED, f"FAILED: sabotage {mode} found nothing to remove from the policy")
    return broken


class Gate:
    def __init__(self, deps: Deps, options: Options) -> None:
        self.deps = deps
        self.options = options
        pid = deps.pid
        self.net = f"csp-magic-link-net-{pid}"
        self.ghost_name = f"csp-magic-link-ghost-{pid}"
        self.origin_name = f"csp-magic-link-origin-{pid}"
        self.spool_name = f"csp-magic-link-spool-{pid}"
        self.host_port = deps.environ.get("CSP_MAGIC_LINK_PORT") or DEFAULT_HOST_PORT
        self.drain_port = deps.environ.get("CSP_MAGIC_LINK_DRAIN_PORT") or DEFAULT_DRAIN_PORT
        self.origin = f"http://localhost:{self.host_port}"
        self.drain_url = f"http://127.0.0.1:{self.drain_port}"
        self.drain_token = ""

    def run(self) -> int:
        """Refuse what cannot run, then run the gate and always clean up.

        Raises:
            GateError: a refusal (exit 2) or a failed setup step (its exit code).
        """
        if self.options.help:
            print(__doc__, file=self.deps.out)
            return 0
        if not (self.deps.repo_root / "render-core" / "dist" / "index.js").is_file():
            raise GateError(
                EXIT_REFUSED,
                "render-core is not built: the policy and the widget addresses are rendered "
                "through its built output (cd render-core && pnpm run build)",
            )
        try:
            return self.gate()
        finally:
            self.cleanup()

    def cleanup(self) -> None:
        # -v also removes each container's anonymous volumes (Ghost's content volume).
        self.silently("docker", "rm", "-fv", self.ghost_name, self.origin_name, self.spool_name)
        self.silently("docker", "network", "rm", self.net)

    def silently(self, *argv: str) -> None:
        """Run a step whose output and failure are both ignored."""
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
    ) -> Command:
        return Command(("node", f"csp/{script}"), env=env, stdin=stdin, stdout=stdout)

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

    def start_spool(self) -> str:
        """The spool the tenant's mail goes to, and the key it registered for the sender
        domain. Nothing is delivered from it: a message stays in its queue until read."""
        image = self.deps.environ.get(SPOOL_IMAGE_ENV) or SPOOL_IMAGE
        if image == SPOOL_IMAGE:
            self.docker("build", "-q", "-t", SPOOL_IMAGE, SPOOL_BUILD_CONTEXT)
        drain_token = self.deps.token()
        settings = [
            "PORT=8080",
            "SHIM_DRAIN_PORT=8081",
            f"SHIM_DRAIN_HOST={SPOOL_ADDRESS}",
            f"SMTP_LISTEN_PORT={SMTP_PORT}",
            "SHIM_DB_PATH=/data/spool.sqlite",
            f"SHIM_DRAIN_TOKEN={drain_token}",
            "SHIM_MESSAGES_PER_HOUR=3600",
        ]
        self.docker(
            *("run", "-d", "--name", self.spool_name, "--network", self.net),
            *("--ip", SPOOL_ADDRESS, "--network-alias", SPOOL_ALIAS),
            *("--user", "31000:31000", "--read-only"),
            *("--tmpfs", "/data:rw,uid=31000,gid=31000,mode=0700"),
            *env_flags(settings),
            *("-p", f"127.0.0.1:{self.drain_port}:8081"),
            image,
        )
        self.wait_for("spool", 60, ("curl", "-sf", "-o", "/dev/null", f"{self.drain_url}/metrics"))
        registered = self.check(
            Command(
                (
                    "docker",
                    *("exec", self.spool_name, "node", "dist/cli.js", "register", SENDER_DOMAIN),
                    *("--sender-domain", SENDER_DOMAIN),
                ),
                stdout="capture",
            )
        )
        key = registered.stdout.strip().splitlines()[-1] if registered.stdout.strip() else ""
        if not key:
            raise GateError(EXIT_REFUSED, "FAILED: the spool registered no key for the sender domain")
        self.drain_token = drain_token
        return key

    def widget_settings(self) -> list[str]:
        """Ghost's widget addresses, from render-core's own table: Portal and the rest on
        the tenant's own origin. With the portal-on-cdn sabotage none is set, so Ghost
        keeps its compiled-in CDN addresses (render-core's `widgets: 'cdn'`)."""
        if self.options.sabotage == SABOTAGE_PORTAL_ON_CDN:
            return []
        rendered = self.check(self.node("proof/render-widgets.ts", {"PROOF_ORIGIN": self.origin}))
        return [line for line in rendered.stdout.splitlines() if "=" in line]

    def start_ghost(self, image: str, spool_key: str) -> None:
        wraps = {"images": "LocalImagesStorage", "media": "LocalMediaStorage", "files": "LocalFilesStorage"}
        settings = [
            f"url={self.origin}",
            "database__client=sqlite3",
            "database__connection__filename=/var/lib/ghost/content/data/ghost-csp-gate.db",
            "privacy__useUpdateCheck=false",
            "BRANCHLEFT_ALLOW_LOCAL_STORAGE=true",
            'logging__transports=["stdout"]',
        ]
        for kind in ("images", "media", "files"):
            settings += [
                f"storage__{kind}__adapter=ScanningStorageAdapter",
                f"storage__{kind}__wraps={wraps[kind]}",
                f"storage__{kind}__quarantinePath=/var/lib/ghost/content/quarantine",
                f"storage__{kind}__verdictSource=in-process-fake",
            ]
        settings += [
            "mail__transport=SMTP",
            f"mail__from=noreply@{SENDER_DOMAIN}",
            f"mail__options__host={SPOOL_ALIAS}",
            f"mail__options__port={SMTP_PORT}",
            "mail__options__secure=false",
            "mail__options__ignoreTLS=true",
            f"mail__options__auth__user={SENDER_DOMAIN}",
        ]
        settings += self.widget_settings()
        # The spool key reaches Ghost through the child's environment, by name, so it is
        # in no argument list.
        args = (
            *("run", "-d", "--name", self.ghost_name, "--network", self.net),
            *env_flags(settings),
            *("-e", "mail__options__auth__pass"),
            image,
        )
        self.docker(*args, env={"mail__options__auth__pass": spool_key})
        ready = ("docker", "exec", self.ghost_name, "wget", "-q", "-O", "/dev/null")
        self.wait_for("Ghost", 90, (*ready, f"http://127.0.0.1:{GHOST_PORT}/"))

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

    def gate(self) -> int:
        image = self.options.image
        if not image:
            image = DEFAULT_GHOST_IMAGE
            self.docker("build", "-q", "-t", image, ".")
        self.docker("build", "-q", "-f", "csp/proof/Dockerfile", "-t", ORIGIN_IMAGE, ".")
        self.docker("network", "create", "--subnet", SPOOL_SUBNET, self.net)
        spool_key = self.start_spool()
        self.start_ghost(image, spool_key)
        self.start_origin(GATE_MARKER_HEADER, "none")

        # setup-content's own exit status is not checked, as in the checkout gate: a
        # failure here shows as the next step failing.
        content_run = self.deps.run(self.node("proof/setup-content.mjs", {"PROOF_ORIGIN": self.origin}))
        content = parse_assignments(content_run.stdout)

        # The theme's own script hashes, from the CLEAN pages of the tenant.
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
        rendering = self.check(self.node("proof/render-header.mjs", {}, stdin=hashes.stdout))
        rendered = rendering.stdout.rstrip("\n")
        if cut_field(rendered, 1) != "enforcing":
            raise GateError(
                EXIT_REFUSED,
                "FAILED: the policy under test is not enforcing (no theme hashes derived?)",
            )
        policy = sabotage_policy(cut_field(rendered, 2), self.options.sabotage)
        self.say(f"POLICY {self.options.sabotage or 'rendered'}: {policy}")

        started = self.deps.now()
        self.start_origin(ENFORCING_HEADER, policy)
        capture_env = {
            "PROOF_ORIGIN": self.origin,
            "PROOF_LABEL": f"magic-link-{self.options.sabotage}" if self.options.sabotage else "magic-link",
            "PROOF_MEMBER_EMAIL": MEMBER_EMAIL,
            "PROOF_DRAIN_URL": self.drain_url,
            "PROOF_DRAIN_TOKEN": self.drain_token,
        }
        run_json = self.check(self.node("proof/capture-magic-link.ts", capture_env)).stdout.rstrip("\n")
        self.say(run_json)
        status = self.judge(run_json)
        elapsed = self.deps.now() - started
        self.say(
            f"GATE_TIMING seconds={elapsed} sabotage={self.options.sabotage or 'none'} exit={status}"
        )
        return status

    def judge(self, run_json: str) -> int:
        verdict = Command(
            (sys.executable, "csp/gate/magic_link_verdict.py", self.origin),
            stdin=run_json,
            stdout="inherit",
        )
        return self.deps.run(verdict).returncode


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
