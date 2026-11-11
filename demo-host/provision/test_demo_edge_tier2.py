#!/usr/bin/env python3
"""Proof, against a local ACME CA, that the demo Caddyfile has Caddy order one
certificate, for the wildcard, and that no slot hostname reaches the CA.

Caddy runs the Caddyfile the real renderer wrote, with a test-only DNS
provider in place of the Hetzner module, against Pebble and
pebble-challtestsrv. The tests read what the CA's logs and Caddy's storage
recorded. test_demo_edge_wildcard.py is the other half: it proves the Hetzner
module accepts the same configuration. How the run is set up, and why a
runner without Docker fails instead of skipping, is in
test_demo_edge_tier2.md.
"""

from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import os
import pathlib
import re
import subprocess
import tempfile
import unittest
import unittest.mock
from typing import Mapping

import demo_edge_tier2 as tier2
import render_demo_edge as rde
import test_demo_edge_wildcard as wildcard

BASE = wildcard.BASE
WILDCARD = wildcard.WILDCARD
SLOT_HOSTS = wildcard.HOSTS
UNMATCHED_HOST = f"unmatched.{BASE}"
TOO_DEEP_HOST = f"a.b.{BASE}"
PROBE_NAMES = [*SLOT_HOSTS, UNMATCHED_HOST, TOO_DEEP_HOST]
PROVIDER = "challtestsrv"
MANAGEMENT_URL = f"http://{tier2.proof_run.LOOPBACK}:{tier2.proof_run.CHALLTESTSRV_MANAGEMENT_PORT}"

PEBBLE_LOG = "\n".join(
    [
        "Pebble 2026/11/04 20:42:47 Starting Pebble ACME server",
        'Pebble 2026/11/04 20:42:50 There are now 1 authorizations in the db',
        'Pebble 2026/11/04 20:42:50 Added order "a8KfU0Q2RReBRwEUmD3oKCQ2yzwS7VDfgfW7UO9ltlA" to the db',
        "Pebble 2026/11/04 20:42:50 There are now 1 orders in the db",
        "Pebble 2026/11/04 20:42:51 Pulled a task from the Tasks queue: &va.vaTask{Identifier:acme.Identifier"
        f'{{Type:"dns", Value:"{BASE}"}}, Challenge:(*core.Challenge)(0xc00009d1e0), '
        'Account:(*core.Account)(0xc00007e4e0), AccountURL:"https://127.0.0.1:14000/my-account/51cf6322", Wildcard:true}',
        "Pebble 2026/11/04 20:42:51 Order a8KfU0Q2RReBRwEUmD3oKCQ2yzwS7VDfgfW7UO9ltlA is fully authorized.",
    ]
)
CHALLTESTSRV_LOG = "\n".join(
    [
        f'pebble-challtestsrv - 2026/11/04 20:42:50 Added TXT response for Host "_acme-challenge.{BASE}." - Value "x"',
        f'pebble-challtestsrv - 2026/11/04 20:42:51 Removed TXT response for Host "_acme-challenge.{BASE}."',
    ]
)
DNS_FRONT_LOG = "\n".join(
    [f"2026/11/04 20:42:50 query _acme-challenge.{BASE}. type=SOA", f"2026/11/04 20:42:50 query {BASE}. type=SOA"]
)


def served_probe(name: str) -> tier2.Probe:
    return tier2.Probe(name, True, "", (WILDCARD,), 502, False)


def good_artifacts() -> tier2.CaseArtifacts:
    """The artifacts of the run the wildcard proof expects."""
    probes = [served_probe(host) for host in SLOT_HOSTS]
    probes.append(tier2.Probe(UNMATCHED_HOST, True, "", (WILDCARD,), None, True))
    probes.append(tier2.Probe(TOO_DEEP_HOST, False, "SSLError: tlsv1 alert internal error", (), None, False))
    return tier2.CaseArtifacts(PEBBLE_LOG, CHALLTESTSRV_LOG, DNS_FRONT_LOG, 1, (f"wildcard_.{BASE}",), tuple(probes))


def problems_of(artifacts: tier2.CaseArtifacts) -> list[str]:
    return tier2.wildcard_proof_problems(artifacts, BASE, SLOT_HOSTS, UNMATCHED_HOST, TOO_DEEP_HOST)


class ParserTests(unittest.TestCase):
    def test_pebble_log_with_one_wildcard_order(self):
        observed = tier2.parse_pebble_log(PEBBLE_LOG)
        self.assertEqual(observed.orders, 1)
        self.assertEqual(observed.authorizations, 1)
        self.assertEqual(observed.validations, (tier2.Validation("dns", BASE, True),))

    def test_pebble_log_with_two_orders_for_slot_names(self):
        lines = []
        for count, host in enumerate(SLOT_HOSTS, start=1):
            lines += [
                f"Pebble x There are now {count} authorizations in the db",
                f'Pebble x Added order "order{count}" to the db',
                f'Pebble x Pulled a task from the Tasks queue: &va.vaTask{{Identifier:acme.Identifier{{Type:"dns", '
                f'Value:"{host}"}}, Challenge:(*core.Challenge)(0x1), Wildcard:false}}',
            ]
        observed = tier2.parse_pebble_log("\n".join(lines))
        self.assertEqual((observed.orders, observed.authorizations), (2, 2))
        self.assertEqual([item.value for item in observed.validations], list(SLOT_HOSTS))
        self.assertEqual([item.wildcard for item in observed.validations], [False, False])

    def test_an_empty_pebble_log_has_seen_nothing(self):
        self.assertEqual(tier2.parse_pebble_log(""), tier2.PebbleObservations(0, 0, ()))

    def test_challtestsrv_log_lists_published_and_cleared_hosts(self):
        observed = tier2.parse_challtestsrv_log(CHALLTESTSRV_LOG)
        self.assertEqual(observed.published, (f"_acme-challenge.{BASE}.",))
        self.assertEqual(observed.cleared, (f"_acme-challenge.{BASE}.",))

    def test_a_probe_record_of_the_wrong_shape_is_refused(self):
        with self.assertRaises(tier2.ProofRunFailed):
            tier2.parse_probe({"name": "x", "tls_verified": "yes"})

    def test_a_probe_record_round_trips(self):
        raw = {"name": "n", "tls_verified": True, "tls_error": "", "san_dns": [WILDCARD], "http_status": None,
               "closed_without_response": True}
        self.assertEqual(tier2.parse_probe(raw), tier2.Probe("n", True, "", (WILDCARD,), None, True))


class JudgementTests(unittest.TestCase):
    def changed(self, **fields: object) -> tier2.CaseArtifacts:
        return dataclasses.replace(good_artifacts(), **fields)

    def assertProblem(self, artifacts: tier2.CaseArtifacts, fragment: str) -> None:
        problems = problems_of(artifacts)
        self.assertTrue(any(fragment in problem for problem in problems), f"{fragment!r} not in {problems}")

    def test_the_expected_run_has_no_problems(self):
        self.assertEqual(problems_of(good_artifacts()), [])
        tier2.assert_wildcard_proof(good_artifacts(), BASE, SLOT_HOSTS, UNMATCHED_HOST, TOO_DEEP_HOST)

    def test_a_second_order_is_a_problem(self):
        extra = PEBBLE_LOG + '\nPebble x Added order "second" to the db'
        self.assertProblem(self.changed(pebble_log=extra), "2 orders")

    def test_a_second_authorization_is_a_problem(self):
        extra = PEBBLE_LOG + "\nPebble x There are now 2 authorizations in the db"
        self.assertProblem(self.changed(pebble_log=extra), "2 authorizations")

    def test_a_validation_that_is_not_the_wildcard_is_a_problem(self):
        plain = PEBBLE_LOG.replace("Wildcard:true", "Wildcard:false")
        self.assertProblem(self.changed(pebble_log=plain), "expected only the wildcard")

    def test_no_validation_at_all_is_a_problem(self):
        silent = "\n".join(line for line in PEBBLE_LOG.splitlines() if "vaTask" not in line)
        self.assertProblem(self.changed(pebble_log=silent), "expected only the wildcard")

    def test_a_challenge_record_for_another_name_is_a_problem(self):
        other = CHALLTESTSRV_LOG.replace("_acme-challenge.", f"_acme-challenge.{SLOT_HOSTS[0].split('.')[0]}.", 1)
        self.assertProblem(self.changed(challtestsrv_log=other), "challenge TXT records")

    def test_an_uncleared_challenge_record_is_a_problem(self):
        uncleared = "\n".join(line for line in CHALLTESTSRV_LOG.splitlines() if "Removed" not in line)
        self.assertProblem(self.changed(challtestsrv_log=uncleared), "cleared []")

    def test_a_slot_name_in_any_ca_side_log_is_a_problem(self):
        for field in ("pebble_log", "challtestsrv_log", "dns_front_log"):
            leaked = getattr(good_artifacts(), field) + f"\nmentions {SLOT_HOSTS[1]}"
            self.assertProblem(self.changed(**{field: leaked}), f"saw the slot hostname {SLOT_HOSTS[1]}")

    def test_a_second_obtained_certificate_is_a_problem(self):
        self.assertProblem(self.changed(obtained_certificates=2), "obtained 2 certificates")

    def test_no_obtained_certificate_is_a_problem(self):
        self.assertProblem(self.changed(obtained_certificates=0), "obtained 0 certificates")

    def test_a_slot_certificate_in_storage_is_a_problem(self):
        stored = (f"wildcard_.{BASE}", SLOT_HOSTS[0])
        self.assertProblem(self.changed(stored_certificates=stored), "storage holds")

    def probes_with(self, replacement: tier2.Probe) -> tier2.CaseArtifacts:
        kept = tuple(probe for probe in good_artifacts().probes if probe.name != replacement.name)
        return self.changed(probes=(*kept, replacement))

    def test_a_slot_name_that_is_not_served_the_wildcard_is_a_problem(self):
        own = tier2.Probe(SLOT_HOSTS[0], True, "", (SLOT_HOSTS[0],), 502, False)
        self.assertProblem(self.probes_with(own), "expected only *.")

    def test_a_slot_name_that_fails_the_handshake_is_a_problem(self):
        broken = tier2.Probe(SLOT_HOSTS[0], False, "certificate verify failed", (), None, False)
        self.assertProblem(self.probes_with(broken), "verified TLS handshake")

    def test_a_slot_name_with_no_http_response_is_a_problem(self):
        silent = tier2.Probe(SLOT_HOSTS[0], True, "", (WILDCARD,), None, True)
        self.assertProblem(self.probes_with(silent), "no HTTP response")

    def test_an_unmatched_name_that_gets_an_answer_is_a_problem(self):
        answered = tier2.Probe(UNMATCHED_HOST, True, "", (WILDCARD,), 200, False)
        self.assertProblem(self.probes_with(answered), "instead of a closed connection")

    def test_a_two_label_name_that_gets_a_certificate_is_a_problem(self):
        covered = tier2.Probe(TOO_DEEP_HOST, True, "", (WILDCARD,), None, True)
        self.assertProblem(self.probes_with(covered), "one label only")

    def test_a_name_that_was_not_probed_is_a_problem(self):
        self.assertProblem(self.changed(probes=()), "was not probed")


class SandboxTests(unittest.TestCase):
    TOKEN = "/work/wildcard/dns-token"

    def rendered(self) -> str:
        return wildcard.render_wildcard_caddyfile(dns_directive=f"dns {PROVIDER} {{file.{self.TOKEN}}}")

    def test_only_the_global_block_changes(self):
        original = self.rendered()
        edited = tier2.proof_run.sandbox_caddyfile(original, "/scratch/wildcard/cert.pem")
        self.assertNotEqual(edited, original)
        before, block, after = original.partition(tier2.proof_run.GLOBAL_BLOCK)
        self.assertEqual(block, tier2.proof_run.GLOBAL_BLOCK)
        self.assertEqual(edited, before + tier2.proof_run.sandbox_global_block("/scratch/wildcard/cert.pem") + after)
        self.assertTrue(after.startswith("\n(slot0-upstream) {"))
        self.assertIn(f"*.{BASE} {{\n\ttls {{\n\t\tdns {PROVIDER} {{file.{self.TOKEN}}}\n\t}}\n", after)

    def test_the_sandbox_block_adds_ports_the_local_ca_and_the_resolver(self):
        block = tier2.proof_run.sandbox_global_block("/scratch/ca.pem")
        for line in ("admin off", "http_port 18080", "https_port 18443", "auto_https disable_redirects",
                     "acme_ca https://127.0.0.1:14000/dir", "acme_ca_root /scratch/ca.pem",
                     "tls_resolvers 127.0.0.1:8054"):
            self.assertIn(f"\t{line}\n", block)

    def test_a_caddyfile_without_the_global_block_is_refused(self):
        with self.assertRaises(tier2.proof_run.SandboxEditError):
            tier2.proof_run.sandbox_caddyfile("example.test {\n}\n", "/scratch/ca.pem")

    def test_a_caddyfile_with_the_global_block_twice_is_refused(self):
        doubled = tier2.proof_run.GLOBAL_BLOCK * 2
        with self.assertRaises(tier2.proof_run.SandboxEditError):
            tier2.proof_run.sandbox_caddyfile(doubled, "/scratch/ca.pem")


class RunnerChoiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.built: list[str] = []
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.bin_dir = pathlib.Path(directory.name)
        for name in tier2.REQUIRED_BINARIES:
            (self.bin_dir / name).write_text("#!/bin/sh\n", encoding="utf-8")
            (self.bin_dir / name).chmod(0o755)

    def build(self) -> str:
        self.built.append("built")
        return "built-image"

    def choose(self, environ: Mapping[str, str], docker_usable: bool) -> tier2.ProofRunner | None:
        return tier2.choose_proof_runner(environ, docker_usable, self.build)

    def test_docker_builds_the_image_and_runs_it(self):
        self.assertEqual(self.choose({}, True), tier2.DockerProofRunner("built-image"))
        self.assertEqual(self.built, ["built"])

    def test_the_binary_directory_override_is_used_locally_without_building(self):
        chosen = self.choose({tier2.BIN_DIR_ENV: str(self.bin_dir)}, True)
        self.assertEqual(chosen, tier2.LocalProofRunner(self.bin_dir))
        self.assertEqual(self.built, [])

    def test_a_directory_missing_one_binary_fails_even_locally(self):
        (self.bin_dir / "soashim").unlink()
        with self.assertRaises(tier2.ProofUnavailable):
            self.choose({tier2.BIN_DIR_ENV: str(self.bin_dir)}, True)

    def test_a_non_executable_binary_fails_even_locally(self):
        (self.bin_dir / "pebble").chmod(0o644)
        with self.assertRaises(tier2.ProofUnavailable):
            self.choose({tier2.BIN_DIR_ENV: str(self.bin_dir)}, True)

    def test_nothing_available_locally_skips(self):
        self.assertIsNone(self.choose({}, False))

    def test_ci_without_docker_fails_instead_of_skipping(self):
        with self.assertRaises(tier2.ProofUnavailable):
            self.choose({"CI": "true"}, False)

    def test_ci_with_the_override_fails_even_with_docker(self):
        with self.assertRaises(tier2.ProofUnavailable):
            self.choose({"CI": "true", tier2.BIN_DIR_ENV: str(self.bin_dir)}, True)

    def test_ci_with_docker_builds_the_image(self):
        self.assertEqual(self.choose({"CI": "true"}, True), tier2.DockerProofRunner("built-image"))

    def test_an_empty_ci_variable_is_not_ci(self):
        self.assertIsNone(self.choose({"CI": ""}, False))


SUMDB_TIMEOUT = (
    '21.84 \tgithub.com/example/module/pkg: github.com/example/module@v1.2.3: verifying module: '
    'github.com/example/module@v1.2.3: Get "https://sum.golang.org/lookup/github.com/example/module@v1.2.3": '
    "dial tcp: lookup sum.golang.org on 168.63.129.16:53: read udp 172.17.0.3:60168->168.63.129.16:53: i/o timeout\n"
    'ERROR: failed to build: failed to solve: process "/bin/sh -c go build" did not complete successfully: exit code: 1'
)
SUMDB_REFUSED = (
    'go: github.com/example/module@v1.2.3: verifying module: github.com/example/module@v1.2.3: '
    'Get "https://sum.golang.org/lookup/github.com/example/module@v1.2.3": dial tcp 127.0.0.1:443: '
    "connect: connection refused\nERROR: failed to build"
)
COMPILE_ERROR = "# example.test/stubdns\nstubdns.go:40:2: undefined: Provider\nERROR: failed to build: exit code: 1"
CHECKSUM_MISMATCH = (
    "verifying github.com/example/module@v1.2.3: checksum mismatch\n"
    "\tdownloaded: h1:AAAA\n\tgo.sum:     h1:BBBB\n\nSECURITY ERROR\n"
    "This download does NOT match an earlier download recorded in go.sum.\nERROR: failed to build"
)


def completed(returncode: int, stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["docker", "build"], returncode, "", stderr)


class ImageBuildRetryTests(unittest.TestCase):
    """build_tier2_image tries again on a network error and on nothing else."""

    def scripted(self, outcomes: tuple[subprocess.CompletedProcess[str] | Exception, ...]):
        """A fake docker run that plays the outcomes in order, with the sleeps and
        build commands it saw."""
        queue = list(outcomes)
        sleeps: list[float] = []
        calls: list[object] = []

        def run(command, **_kwargs):
            calls.append(command)
            outcome = queue.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        return run, sleeps, calls

    def build(self, *outcomes: subprocess.CompletedProcess[str] | Exception) -> tuple[str, list[float], int]:
        """Returns the tag, the sleeps taken and how many builds ran."""
        run, sleeps, calls = self.scripted(outcomes)
        with unittest.mock.patch("atexit.register"), contextlib.redirect_stderr(io.StringIO()):
            tag = tier2.build_tier2_image(run=run, sleep=sleeps.append)
        return tag, sleeps, len(calls)

    def fails(self, *outcomes: subprocess.CompletedProcess[str] | Exception) -> tuple[str, list[float], int]:
        """For a run that must raise ProofImageBuildFailed. Returns the message,
        the sleeps taken and how many builds ran."""
        run, sleeps, calls = self.scripted(outcomes)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(tier2.ProofImageBuildFailed) as caught:
            tier2.build_tier2_image(run=run, sleep=sleeps.append)
        return str(caught.exception), sleeps, len(calls)

    def test_a_clean_build_runs_once(self):
        _tag, sleeps, calls = self.build(completed(0))
        self.assertEqual((sleeps, calls), ([], 1))

    def test_a_checksum_database_timeout_is_tried_again_and_can_succeed(self):
        _tag, sleeps, calls = self.build(completed(1, SUMDB_TIMEOUT), completed(0))
        self.assertEqual((sleeps, calls), ([tier2.IMAGE_BUILD_BACKOFF_SECONDS[0]], 2))

    def test_a_refused_connection_is_tried_again(self):
        _tag, sleeps, calls = self.build(completed(1, SUMDB_REFUSED), completed(1, SUMDB_TIMEOUT), completed(0))
        self.assertEqual((sleeps, calls), (list(tier2.IMAGE_BUILD_BACKOFF_SECONDS), 3))

    def test_a_network_error_every_time_stops_at_the_attempt_limit_and_says_so(self):
        message, sleeps, calls = self.fails(*[completed(1, SUMDB_TIMEOUT)] * tier2.IMAGE_BUILD_ATTEMPTS)
        self.assertEqual(calls, tier2.IMAGE_BUILD_ATTEMPTS)
        self.assertEqual(len(sleeps), tier2.IMAGE_BUILD_ATTEMPTS - 1)
        self.assertIn(f"attempt {tier2.IMAGE_BUILD_ATTEMPTS} of {tier2.IMAGE_BUILD_ATTEMPTS}", message)
        self.assertIn("sum.golang.org", message)

    def test_a_compile_error_is_not_tried_again(self):
        message, sleeps, calls = self.fails(completed(1, COMPILE_ERROR), completed(0))
        self.assertEqual((sleeps, calls), ([], 1))
        self.assertIn("undefined: Provider", message)

    def test_a_checksum_mismatch_is_not_tried_again(self):
        _message, sleeps, calls = self.fails(completed(1, CHECKSUM_MISMATCH), completed(0))
        self.assertEqual((sleeps, calls), ([], 1))

    def test_a_network_line_next_to_a_compile_error_is_not_tried_again(self):
        _message, sleeps, calls = self.fails(completed(1, SUMDB_TIMEOUT + "\n" + COMPILE_ERROR), completed(0))
        self.assertEqual((sleeps, calls), ([], 1))

    def test_a_failure_with_no_network_text_is_not_tried_again(self):
        _message, sleeps, calls = self.fails(completed(1, "ERROR: failed to build: exit code: 1"), completed(0))
        self.assertEqual((sleeps, calls), ([], 1))

    def test_a_timeout_is_not_tried_again(self):
        _message, sleeps, calls = self.fails(subprocess.TimeoutExpired("docker", 1), completed(0))
        self.assertEqual((sleeps, calls), ([], 1))


class HermeticBuildTests(unittest.TestCase):
    """The image build contacts no checksum database because every module it
    builds is listed, with its hash, in a committed go.sum."""

    MODULE_DIRECTORIES = ("caddy", "ca", "tools")
    LOOSENING = (
        "xcaddy", "GOSUMDB", "GONOSUMDB", "GONOSUMCHECK", "GOINSECURE", "GOFLAGS", "GOPROXY", "GOPRIVATE",
        "GONOPROXY", "GOTOOLCHAIN", "-mod=mod", "-insecure", "go get", "go mod tidy", "go install github.com",
    )

    def dockerfile_instructions(self) -> str:
        text = (tier2.TIER2_DIRECTORY / "Dockerfile").read_text(encoding="utf-8")
        return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))

    def test_the_dockerfile_loosens_nothing_and_fetches_no_unpinned_module(self):
        instructions = self.dockerfile_instructions()
        for word in self.LOOSENING:
            self.assertNotIn(word, instructions, word)

    def test_every_go_stage_builds_from_a_module_directory_with_its_hashes(self):
        instructions = self.dockerfile_instructions()
        for name in self.MODULE_DIRECTORIES:
            self.assertTrue((tier2.TIER2_DIRECTORY / name / "go.mod").is_file(), name)
            self.assertTrue((tier2.TIER2_DIRECTORY / name / "go.sum").is_file(), name)
        self.assertIn("COPY caddy ", instructions)
        self.assertIn("COPY ca ", instructions)
        self.assertIn("COPY tools ", instructions)

    def test_every_required_module_has_its_hash_in_go_sum(self):
        for name in self.MODULE_DIRECTORIES:
            directory = tier2.TIER2_DIRECTORY / name
            sums = (directory / "go.sum").read_text(encoding="utf-8")
            required = [
                line.split()[:2]
                for line in (directory / "go.mod").read_text(encoding="utf-8").splitlines()
                if line.startswith("\t") and len(line.split()) >= 2 and line.split()[1].startswith("v")
                and not line.split()[0].startswith("example.test/")
            ]
            self.assertTrue(required, name)
            for module, version in required:
                listed = re.search(rf"(?m)^{re.escape(module)} {re.escape(version)}/go\.mod h1:", sums)
                self.assertIsNotNone(listed, f"{name}/go.sum has no hash for {module} {version}")

    def test_the_caddy_version_is_one_value_in_the_module_and_the_stub_provider(self):
        def caddy_version(path: pathlib.Path) -> str:
            match = re.search(r"github\.com/caddyserver/caddy/v2 (v\S+)", path.read_text(encoding="utf-8"))
            self.assertIsNotNone(match, path)
            return match.group(1)

        self.assertEqual(
            caddy_version(tier2.TIER2_DIRECTORY / "caddy" / "go.mod"),
            caddy_version(tier2.TIER2_DIRECTORY / "stubdns" / "go.mod"),
        )


_RESOLUTION: list[tier2.ProofRunner | tier2.ProofUnavailable | None] = []


def resolve_proof_runner() -> tier2.ProofRunner | None:
    """The process-wide runner. A failure to build the image is remembered, so
    a second class does not rebuild it. Raises what `choose_proof_runner` and
    `build_tier2_image` raise."""
    if not _RESOLUTION:
        try:
            _RESOLUTION.append(
                tier2.choose_proof_runner(os.environ, wildcard.docker_is_usable(), tier2.build_tier2_image)
            )
        except tier2.ProofUnavailable as error:
            _RESOLUTION.append(error)
    outcome = _RESOLUTION[0]
    if isinstance(outcome, tier2.ProofUnavailable):
        raise outcome
    return outcome


def per_host_caddyfile(token_path: str) -> str:
    """The retired form: one `https://<host>` site per slot, each with its own
    certificate from the same DNS provider."""
    sites = "".join(
        f"https://{host} {{\n\ttls {{\n\t\tdns {PROVIDER} {{file.{token_path}}}\n\t}}\n"
        f"\treverse_proxy 127.0.0.1:{9300 + index}\n}}\n\n"
        for index, host in enumerate(SLOT_HOSTS)
    )
    return rde.render() + "\n" + sites


def write_case(work: pathlib.Path, name: str, caddyfile: str, expected_certificates: int) -> None:
    directory = work / name
    directory.mkdir()
    (directory / "Caddyfile").write_text(caddyfile, encoding="utf-8")
    (directory / "dns-token").write_text(MANAGEMENT_URL + "\n", encoding="utf-8")
    spec = {"base": BASE, "expected_certificates": expected_certificates, "probe_names": PROBE_NAMES}
    (directory / "case.json").write_text(json.dumps(spec), encoding="utf-8")


class RealCaPoweredTests(unittest.TestCase):
    """One container run holds both cases, so the image is built once and the
    two Caddyfiles go through the same harness."""

    caddyfiles: dict[str, str]
    artifacts: dict[str, tier2.CaseArtifacts]
    loaded: dict[str, str]

    @classmethod
    def setUpClass(cls) -> None:
        runner = resolve_proof_runner()
        if runner is None:
            raise unittest.SkipTest(
                f"no Docker and no {tier2.BIN_DIR_ENV}: the Tier 2 proof did not run (CI fails here)"
            )
        scratch = tempfile.TemporaryDirectory()
        cls.addClassCleanup(scratch.cleanup)
        work, out = pathlib.Path(scratch.name) / "work", pathlib.Path(scratch.name) / "out"
        work.mkdir(mode=0o755)
        out.mkdir(mode=0o777)
        work.chmod(0o755)
        out.chmod(0o777)
        directive = f"dns {PROVIDER} {{file.{runner.path_in_run(work, 'wildcard/dns-token')}}}"
        cls.caddyfiles = {
            "wildcard": wildcard.render_wildcard_caddyfile(dns_directive=directive),
            "per-host": per_host_caddyfile(runner.path_in_run(work, "per-host/dns-token")),
        }
        write_case(work, "wildcard", cls.caddyfiles["wildcard"], 1)
        write_case(work, "per-host", cls.caddyfiles["per-host"], len(SLOT_HOSTS))
        runner.run(work, out)
        cls.artifacts = {name: tier2.load_artifacts(out / name) for name in cls.caddyfiles}
        cls.loaded = {name: (out / name / "Caddyfile.loaded").read_text(encoding="utf-8") for name in cls.caddyfiles}

    def test_the_ca_orders_one_wildcard_certificate_and_no_slot_name(self):
        tier2.assert_wildcard_proof(self.artifacts["wildcard"], BASE, SLOT_HOSTS, UNMATCHED_HOST, TOO_DEEP_HOST)

    def test_the_per_host_form_is_caught_by_the_same_checks(self):
        problems = problems_of(self.artifacts["per-host"])
        self.assertTrue(any("2 orders" in problem for problem in problems), problems)
        for host in SLOT_HOSTS:
            self.assertTrue(any(f"saw the slot hostname {host}" in problem for problem in problems), problems)
        with self.assertRaises(tier2.WildcardProofViolation):
            tier2.assert_wildcard_proof(self.artifacts["per-host"], BASE, SLOT_HOSTS, UNMATCHED_HOST, TOO_DEEP_HOST)

    def test_caddy_loaded_the_renderers_caddyfile_with_only_its_global_block_edited(self):
        for name, rendered in self.caddyfiles.items():
            before, block, after = rendered.partition(tier2.proof_run.GLOBAL_BLOCK)
            self.assertEqual(block, tier2.proof_run.GLOBAL_BLOCK, name)
            loaded_before, loaded_block, loaded_after = self.loaded[name].partition(
                tier2.proof_run.sandbox_global_block(self.loaded_ca_root(name))
            )
            self.assertEqual((loaded_before, loaded_after), (before, after), name)
            self.assertNotEqual(loaded_block, "", name)

    def loaded_ca_root(self, name: str) -> str:
        marker = "\tacme_ca_root "
        line = next(line for line in self.loaded[name].splitlines() if line.startswith(marker))
        return line[len(marker):]


if __name__ == "__main__":
    unittest.main()
