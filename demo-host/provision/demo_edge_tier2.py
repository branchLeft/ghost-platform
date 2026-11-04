"""Judges what a real Caddy and a local ACME CA did with the demo Caddyfile.

tier2/run_wildcard_proof.py runs the components (in the image built from
tier2/Dockerfile, or from local binaries) and writes logs and a result file
per case. This module reads those artifacts and says what is wrong with them.
The parsers and judgement are pure functions, so they are unit-tested on text
and need no Docker. How a runner is chosen, and why a runner that cannot
run fails under CI instead of skipping, is in test_demo_edge_tier2.md.
"""

from __future__ import annotations

import atexit
import json
import os
import pathlib
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Mapping, Protocol, Sequence

TIER2_DIRECTORY = pathlib.Path(__file__).parent / "tier2"
# The run script is a standalone file for the image; its constants (ports,
# the global block) are read from it so there is one copy of each.
sys.path.insert(0, str(TIER2_DIRECTORY))
import run_wildcard_proof as proof_run  # noqa: E402

BIN_DIR_ENV = "DEMO_EDGE_TIER2_BIN_DIR"
REQUIRED_BINARIES = (proof_run.CADDY_BINARY, "pebble", "pebble-challtestsrv", "soashim", "mkcert")
IMAGE_BUILD_SECONDS = 1500
PROOF_RUN_SECONDS = 600
IN_IMAGE_BIN_DIR = "/usr/local/bin"
IN_IMAGE_SCRIPT = "/opt/tier2/run_wildcard_proof.py"

PEBBLE_ORDER_ADDED = re.compile(r'Added order "[^"]+" to the db')
PEBBLE_AUTHORIZATIONS = re.compile(r"There are now (?P<count>[0-9]+) authorizations in the db")
PEBBLE_VALIDATION = re.compile(
    r'Pulled a task from the Tasks queue: &va\.vaTask\{Identifier:acme\.Identifier\{Type:"(?P<kind>[^"]*)", '
    r'Value:"(?P<value>[^"]*)"\}.*Wildcard:(?P<wildcard>true|false)\}'
)
CHALLTESTSRV_SET = re.compile(r'Added TXT response for Host "(?P<host>[^"]+)"')
CHALLTESTSRV_CLEARED = re.compile(r'Removed TXT response for Host "(?P<host>[^"]+)"')


class ProofUnavailable(RuntimeError):
    """No usable way to run the proof where one is required."""


class ProofImageBuildFailed(ProofUnavailable):
    """The Tier 2 image did not build."""


class ProofRunFailed(RuntimeError):
    """The run script exited non-zero, timed out, or left no artifacts."""


class WildcardProofViolation(AssertionError):
    """The CA or Caddy saw something other than the one wildcard name."""

    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = list(problems)


@dataclass(frozen=True)
class Validation:
    """One challenge validation Pebble began."""

    kind: str
    value: str
    wildcard: bool


@dataclass(frozen=True)
class PebbleObservations:
    orders: int
    authorizations: int
    validations: tuple[Validation, ...]


@dataclass(frozen=True)
class ChallengeObservations:
    published: tuple[str, ...]
    cleared: tuple[str, ...]


@dataclass(frozen=True)
class Probe:
    name: str
    tls_verified: bool
    tls_error: str
    san_dns: tuple[str, ...]
    http_status: int | None
    closed_without_response: bool


@dataclass(frozen=True)
class CaseArtifacts:
    pebble_log: str
    challtestsrv_log: str
    dns_front_log: str
    obtained_certificates: int
    stored_certificates: tuple[str, ...]
    probes: tuple[Probe, ...]


def parse_pebble_log(text: str) -> PebbleObservations:
    counts = [int(match.group("count")) for match in PEBBLE_AUTHORIZATIONS.finditer(text)]
    validations = tuple(
        Validation(match.group("kind"), match.group("value"), match.group("wildcard") == "true")
        for match in PEBBLE_VALIDATION.finditer(text)
    )
    return PebbleObservations(len(PEBBLE_ORDER_ADDED.findall(text)), max(counts, default=0), validations)


def parse_challtestsrv_log(text: str) -> ChallengeObservations:
    return ChallengeObservations(
        tuple(match.group("host") for match in CHALLTESTSRV_SET.finditer(text)),
        tuple(match.group("host") for match in CHALLTESTSRV_CLEARED.finditer(text)),
    )


def parse_probe(raw: Mapping[str, object]) -> Probe:
    """Raises ProofRunFailed for a probe record that is not the expected shape."""
    names, status = raw.get("san_dns"), raw.get("http_status")
    if (
        not isinstance(raw.get("name"), str)
        or not isinstance(raw.get("tls_verified"), bool)
        or not isinstance(raw.get("tls_error"), str)
        or not isinstance(raw.get("closed_without_response"), bool)
        or not isinstance(names, list)
        or not (status is None or isinstance(status, int))
    ):
        raise ProofRunFailed(f"a probe record has an unexpected shape: {raw!r}")
    return Probe(
        str(raw["name"]), bool(raw["tls_verified"]), str(raw["tls_error"]),
        tuple(str(name) for name in names), status, bool(raw["closed_without_response"]),
    )


def load_artifacts(case_directory: pathlib.Path) -> CaseArtifacts:
    """Raises ProofRunFailed when the run left no usable artifacts for the case."""
    try:
        result = json.loads((case_directory / "result.json").read_text(encoding="utf-8"))
        logs = [(case_directory / name).read_text(encoding="utf-8", errors="replace")
                for name in ("pebble.log", "challtestsrv.log", "soashim.log")]
    except OSError as error:
        raise ProofRunFailed(f"artifacts missing under {case_directory}: {error}") from error
    obtained, stored, probes = result.get("obtained_certificates"), result.get("stored_certificates"), result.get("probes")
    if not isinstance(obtained, int) or not isinstance(stored, list) or not isinstance(probes, list):
        raise ProofRunFailed(f"{case_directory}/result.json is not the expected shape")
    return CaseArtifacts(logs[0], logs[1], logs[2], obtained, tuple(str(name) for name in stored),
                         tuple(parse_probe(probe) for probe in probes))


def ca_problems(artifacts: CaseArtifacts, base: str) -> list[str]:
    """What the CA's own logs say that is not exactly one wildcard order."""
    problems: list[str] = []
    pebble = parse_pebble_log(artifacts.pebble_log)
    challenge = parse_challtestsrv_log(artifacts.challtestsrv_log)
    if pebble.orders != 1:
        problems.append(f"Pebble saw {pebble.orders} orders, expected exactly 1")
    if pebble.authorizations != 1:
        problems.append(f"Pebble holds {pebble.authorizations} authorizations, expected exactly 1")
    if pebble.validations != (Validation("dns", base, True),):
        problems.append(f"Pebble validated {list(pebble.validations)}, expected only the wildcard of {base}")
    expected_host = (f"_acme-challenge.{base}.",)
    if challenge.published != expected_host or challenge.cleared != expected_host:
        problems.append(
            f"challenge TXT records published {list(challenge.published)} and cleared {list(challenge.cleared)}, "
            f"expected only {list(expected_host)}"
        )
    return problems


def slot_name_leaks(artifacts: CaseArtifacts, slot_hosts: Sequence[str]) -> list[str]:
    """One line per CA-side log that mentions a slot hostname at all."""
    sources = (("Pebble", artifacts.pebble_log), ("challtestsrv", artifacts.challtestsrv_log),
               ("the DNS front", artifacts.dns_front_log))
    return [f"{source} saw the slot hostname {host}" for source, text in sources for host in slot_hosts if host in text]


def probe_by_name(artifacts: CaseArtifacts, name: str) -> Probe | None:
    return next((probe for probe in artifacts.probes if probe.name == name), None)


def served_problems(probe: Probe | None, name: str, wildcard: str) -> list[str]:
    if probe is None:
        return [f"{name} was not probed"]
    if not probe.tls_verified:
        return [f"{name} did not complete a verified TLS handshake: {probe.tls_error}"]
    problems: list[str] = []
    if probe.san_dns != (wildcard,):
        problems.append(f"{name} was served a certificate for {list(probe.san_dns)}, expected only {wildcard}")
    if probe.http_status is None:
        problems.append(f"{name} got no HTTP response")
    return problems


def aborted_problems(probe: Probe | None, name: str) -> list[str]:
    if probe is None:
        return [f"{name} was not probed"]
    if not probe.tls_verified:
        return [f"{name} did not complete a verified TLS handshake: {probe.tls_error}"]
    if not probe.closed_without_response:
        return [f"{name} was answered with HTTP {probe.http_status} instead of a closed connection"]
    return []


def refused_problems(probe: Probe | None, name: str) -> list[str]:
    if probe is None:
        return [f"{name} was not probed"]
    if probe.tls_verified:
        return [f"{name} completed a verified TLS handshake, but the wildcard covers one label only"]
    return []


def caddy_problems(artifacts: CaseArtifacts, base: str) -> list[str]:
    problems: list[str] = []
    if artifacts.obtained_certificates != 1:
        problems.append(f"Caddy obtained {artifacts.obtained_certificates} certificates, expected exactly 1")
    if artifacts.stored_certificates != (f"wildcard_.{base}",):
        problems.append(f"Caddy's storage holds {list(artifacts.stored_certificates)}, expected only wildcard_.{base}")
    return problems


def wildcard_proof_problems(
    artifacts: CaseArtifacts, base: str, slot_hosts: Sequence[str], unmatched_host: str, too_deep_host: str
) -> list[str]:
    """Every way the artifacts differ from: one order, for the wildcard
    alone; the slot names visible nowhere on the CA side; slot names served
    that certificate; an unmatched one-label name aborted; a two-label name
    given no certificate."""
    problems = ca_problems(artifacts, base) + slot_name_leaks(artifacts, slot_hosts)
    problems += caddy_problems(artifacts, base)
    for host in slot_hosts:
        problems += served_problems(probe_by_name(artifacts, host), host, f"*.{base}")
    problems += aborted_problems(probe_by_name(artifacts, unmatched_host), unmatched_host)
    problems += refused_problems(probe_by_name(artifacts, too_deep_host), too_deep_host)
    return problems


def assert_wildcard_proof(
    artifacts: CaseArtifacts, base: str, slot_hosts: Sequence[str], unmatched_host: str, too_deep_host: str
) -> None:
    """Raises WildcardProofViolation listing every problem found."""
    problems = wildcard_proof_problems(artifacts, base, slot_hosts, unmatched_host, too_deep_host)
    if problems:
        raise WildcardProofViolation(problems)


class ProofRunner(Protocol):
    def path_in_run(self, work: pathlib.Path, relative: str) -> str: ...

    def run(self, work: pathlib.Path, out: pathlib.Path) -> None: ...


@dataclass(frozen=True)
class LocalProofRunner:
    """Local binaries named by DEMO_EDGE_TIER2_BIN_DIR: a development
    stand-in for the image, refused wherever CI is set."""

    bin_dir: pathlib.Path

    def path_in_run(self, work: pathlib.Path, relative: str) -> str:
        return str(work / relative)

    def run(self, work: pathlib.Path, out: pathlib.Path) -> None:
        scratch = work / "scratch"
        scratch.mkdir()
        command = [sys.executable, str(TIER2_DIRECTORY / "run_wildcard_proof.py"), "--work", str(work),
                   "--out", str(out), "--scratch", str(scratch), "--bin-dir", str(self.bin_dir)]
        execute(command)


@dataclass(frozen=True)
class DockerProofRunner:
    """The image built from tier2/Dockerfile: no network, a read-only root,
    no capabilities, the caller's own uid, the cases mounted read-only at
    /work and the artifacts written to /out."""

    image: str

    def path_in_run(self, work: pathlib.Path, relative: str) -> str:
        return f"/work/{relative}"

    def run(self, work: pathlib.Path, out: pathlib.Path) -> None:
        command = [
            "docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--user", f"{os.getuid()}:{os.getgid()}",
            "--tmpfs", "/scratch:rw,size=256m", "-v", f"{work}:/work:ro", "-v", f"{out}:/out", self.image,
            "python3", IN_IMAGE_SCRIPT, "--work", "/work", "--out", "/out", "--scratch", "/scratch",
            "--bin-dir", IN_IMAGE_BIN_DIR,
        ]
        execute(command)


def execute(command: Sequence[str]) -> None:
    """Raises ProofRunFailed unless the command exits zero in time."""
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=PROOF_RUN_SECONDS, check=False)
    except subprocess.TimeoutExpired as error:
        raise ProofRunFailed("the Tier 2 run timed out") from error
    if done.returncode != 0:
        raise ProofRunFailed(f"the Tier 2 run exited {done.returncode}:\n{done.stdout[-1500:]}\n{done.stderr[-3000:]}")


def has_all_binaries(bin_dir: pathlib.Path) -> bool:
    return all(os.access(bin_dir / name, os.X_OK) and (bin_dir / name).is_file() for name in REQUIRED_BINARIES)


def choose_proof_runner(
    environ: Mapping[str, str], docker_usable: bool, build_image: Callable[[], str]
) -> ProofRunner | None:
    """The runner for this environment, or None when nothing is available and
    CI is not set (the caller skips). `build_image` returns the built image's tag.

    Raises ProofUnavailable when CI is set and Docker is not usable, when CI
    is set together with the binary directory override, or when the override
    does not hold every required executable."""
    bin_dir = environ.get(BIN_DIR_ENV, "")
    in_ci = environ.get("CI", "") != ""
    if in_ci and bin_dir:
        raise ProofUnavailable(f"{BIN_DIR_ENV} is set under CI: CI must prove the image, not local binaries")
    if bin_dir:
        if not has_all_binaries(pathlib.Path(bin_dir)):
            raise ProofUnavailable(f"{BIN_DIR_ENV} must hold executable files named {', '.join(REQUIRED_BINARIES)}")
        return LocalProofRunner(pathlib.Path(bin_dir))
    if docker_usable:
        return DockerProofRunner(build_image())
    if in_ci:
        raise ProofUnavailable("docker is required for the Tier 2 proof in CI and is not usable")
    return None


def build_tier2_image() -> str:
    """Builds tier2/Dockerfile and returns the tag, removing the image at
    interpreter exit. Raises ProofImageBuildFailed when the build fails or
    times out."""
    tag = f"demo-edge-tier2-test:{os.getpid()}"
    command = ["docker", "build", "--tag", tag, "--file", str(TIER2_DIRECTORY / "Dockerfile"), str(TIER2_DIRECTORY)]
    try:
        build = subprocess.run(command, capture_output=True, text=True, timeout=IMAGE_BUILD_SECONDS, check=False)
    except subprocess.TimeoutExpired as error:
        raise ProofImageBuildFailed("the Tier 2 image build timed out") from error
    if build.returncode != 0:
        raise ProofImageBuildFailed(f"the Tier 2 image build failed:\n{build.stderr[-3000:]}")
    atexit.register(subprocess.run, ["docker", "rmi", "--force", tag], capture_output=True, check=False)
    return tag
