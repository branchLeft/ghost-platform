#!/usr/bin/env python3
"""Proof, with a real Caddy, that the demo Caddyfile obtains a certificate for
the one wildcard name and for no slot name.

The names Caddy would obtain certificates for are read out of the JSON its
own Caddyfile adapter produces, so this holds the renderer to what Caddy does
with the text and not to what the renderer believes it wrote. The Caddy is
the one in the image built from services/demo-edge/Dockerfile. How the tests
reach it, and why a runner without Docker fails instead of skipping, is in
test_demo_edge_wildcard.md.
"""

from __future__ import annotations

import atexit
import copy
import json
import os
import pathlib
import re
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from typing import Callable, Iterator, Mapping, Protocol, Sequence, Union

import render_demo_edge as rde
import render_demo_site as rds

JsonValue = Union[str, int, float, bool, None, list["JsonValue"], dict[str, "JsonValue"]]
JsonObject = dict[str, JsonValue]
PathKey = Union[str, int]

REPOSITORY = pathlib.Path(__file__).parents[2]
GOLDEN = REPOSITORY / "render-core" / "test" / "golden" / "demo.edge.json"
IMAGE_CONTEXT = REPOSITORY / "services" / "demo-edge"
BASE = "demo-domain.example.test"
WILDCARD = f"*.{BASE}"
FIRST_HOST = f"k7m-vale-bright.{BASE}"
SECOND_HOST = f"p4q-rowan-quiet.{BASE}"
HOSTS = (FIRST_HOST, SECOND_HOST)
FAKE_TOKEN = "fake-dns-token-not-a-credential"
HETZNER_MODULE = "dns.providers.hetzner"
CADDY_BINARY_ENV = "DEMO_EDGE_CADDY_BIN"
DOCKER_PROBE_SECONDS = 30
IMAGE_BUILD_SECONDS = 600
CADDY_RUN_SECONDS = 120

# A slot host may appear in the adapted config only as an entry of a route's
# host matcher, however deeply subroutes nest that route.
ROUTE_HOST_MATCHER_PATH = re.compile(
    r"\Aapps/http/servers/[^/]+/routes/[0-9]+(?:/handle/[0-9]+/routes/[0-9]+)*/match/[0-9]+/host/[0-9]+\Z"
)


class CaddyUnavailable(RuntimeError):
    """No usable real Caddy where one is required."""


class ImageBuildFailed(CaddyUnavailable):
    """The demo-edge image did not build."""


class CaddyCommandFailed(RuntimeError):
    """A caddy invocation exited non-zero or timed out."""


class WildcardViolation(AssertionError):
    """The adapted config manages, or exposes, more than the one wildcard name."""

    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = list(problems)


class ProviderViolation(AssertionError):
    """The adapted config does not use the Hetzner provider with a file token."""


class CaddyRunner(Protocol):
    def path_in_caddy(self, workdir: pathlib.Path, name: str) -> str: ...

    def command(self, workdir: pathlib.Path, arguments: Sequence[str]) -> list[str]: ...


@dataclass(frozen=True)
class BinaryRunner:
    """A local executable, named by DEMO_EDGE_CADDY_BIN: a development
    stand-in for the image, refused wherever CI is set."""

    binary: str

    def path_in_caddy(self, workdir: pathlib.Path, name: str) -> str:
        return str(workdir / name)

    def command(self, workdir: pathlib.Path, arguments: Sequence[str]) -> list[str]:
        return [self.binary, *arguments]


@dataclass(frozen=True)
class DockerRunner:
    """The image built from the Dockerfile, run with no network and the
    scratch directory mounted read-only at /work."""

    image: str

    def path_in_caddy(self, workdir: pathlib.Path, name: str) -> str:
        return f"/work/{name}"

    def command(self, workdir: pathlib.Path, arguments: Sequence[str]) -> list[str]:
        return ["docker", "run", "--rm", "--network", "none", "-v", f"{workdir}:/work:ro", self.image,
                "caddy", *arguments]


def choose_runner(
    environ: Mapping[str, str],
    docker_usable: bool,
    build_image: Callable[[], str],
) -> CaddyRunner | None:
    """The runner for this environment, or None when nothing is available and
    CI is not set (the caller skips). `build_image` returns the built image's tag.

    Raises CaddyUnavailable when CI is set and Docker is not usable, when CI is
    set together with the binary override, or when the override does not name
    an executable file."""
    binary = environ.get(CADDY_BINARY_ENV, "")
    in_ci = environ.get("CI", "") != ""
    if in_ci and binary:
        raise CaddyUnavailable(f"{CADDY_BINARY_ENV} is set under CI: CI must prove the image, not a local binary")
    if binary:
        if not (os.path.isfile(binary) and os.access(binary, os.X_OK)):
            raise CaddyUnavailable(f"{CADDY_BINARY_ENV} does not name an executable file")
        return BinaryRunner(binary)
    if docker_usable:
        return DockerRunner(build_image())
    if in_ci:
        raise CaddyUnavailable("docker is required for the real-Caddy proof in CI and is not usable")
    return None


def docker_is_usable() -> bool:
    try:
        probe = subprocess.run(["docker", "info"], capture_output=True, timeout=DOCKER_PROBE_SECONDS, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return probe.returncode == 0


def build_demo_edge_image() -> str:
    """Builds the Dockerfile and returns the image tag, removing the image at
    interpreter exit. Raises ImageBuildFailed when the build fails or times out."""
    tag = f"demo-edge-wildcard-test:{os.getpid()}"
    command = ["docker", "build", "--tag", tag, "--file", str(IMAGE_CONTEXT / "Dockerfile"), str(IMAGE_CONTEXT)]
    try:
        build = subprocess.run(command, capture_output=True, text=True, timeout=IMAGE_BUILD_SECONDS, check=False)
    except subprocess.TimeoutExpired as error:
        raise ImageBuildFailed("the demo-edge image build timed out") from error
    if build.returncode != 0:
        raise ImageBuildFailed(f"the demo-edge image build failed:\n{build.stderr[-3000:]}")
    atexit.register(subprocess.run, ["docker", "rmi", "--force", tag], capture_output=True, check=False)
    return tag


_RESOLUTION: list[CaddyRunner | CaddyUnavailable | None] = []


def resolve_runner() -> CaddyRunner | None:
    """The process-wide runner: the image is built once, and a failure to
    build it is remembered so no later test class rebuilds it. Raises what
    `choose_runner` and `build_demo_edge_image` raise."""
    if not _RESOLUTION:
        try:
            _RESOLUTION.append(choose_runner(os.environ, docker_is_usable(), build_demo_edge_image))
        except CaddyUnavailable as error:
            _RESOLUTION.append(error)
    outcome = _RESOLUTION[0]
    if isinstance(outcome, CaddyUnavailable):
        raise outcome
    return outcome


def run_caddy(runner: CaddyRunner, workdir: pathlib.Path, arguments: Sequence[str]) -> subprocess.CompletedProcess[str]:
    """Raises CaddyCommandFailed unless caddy exits zero."""
    command = runner.command(workdir, arguments)
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=CADDY_RUN_SECONDS, check=False)
    except subprocess.TimeoutExpired as error:
        raise CaddyCommandFailed(f"caddy {arguments[0]} timed out") from error
    if done.returncode != 0:
        raise CaddyCommandFailed(f"caddy {arguments[0]} exited {done.returncode}:\n{done.stderr[-3000:]}")
    return done


def adapt_caddyfile(runner: CaddyRunner, workdir: pathlib.Path) -> JsonObject:
    """Validates the Caddyfile in `workdir`, then returns Caddy's own JSON for it.
    Raises CaddyCommandFailed for a config Caddy refuses and AssertionError
    when validate does not say the configuration is valid."""
    config = runner.path_in_caddy(workdir, "Caddyfile")
    validated = run_caddy(runner, workdir, ["validate", "--adapter", "caddyfile", "--config", config])
    if "Valid configuration" not in validated.stdout + validated.stderr:
        raise AssertionError("caddy validate did not report a valid configuration")
    adapted = run_caddy(runner, workdir, ["adapt", "--adapter", "caddyfile", "--config", config])
    parsed: JsonObject = json.loads(adapted.stdout)
    return parsed


def walk(value: JsonValue, path: tuple[PathKey, ...] = ()) -> Iterator[tuple[tuple[PathKey, ...], JsonValue]]:
    """Every node of a JSON document with the path to it, parents first."""
    yield path, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, (*path, index))


def strings_under_key(adapted: JsonObject, key: str) -> list[str]:
    """Every string listed under a key of that name, anywhere in the document."""
    found: list[str] = []
    for path, value in walk(adapted):
        if path and path[-1] == key and isinstance(value, list):
            found += [item for item in value if isinstance(item, str)]
    return found


def managed_subjects(adapted: JsonObject) -> list[str]:
    """The distinct names Caddy would obtain certificates for: every
    automation subject and every TLS connection policy SNI, wherever they sit."""
    return sorted(set(strings_under_key(adapted, "subjects") + strings_under_key(adapted, "sni")))


def automation_policies(adapted: JsonObject) -> list[JsonValue]:
    node: JsonValue = adapted
    for key in ("apps", "tls", "automation", "policies"):
        node = node.get(key) if isinstance(node, dict) else None
    return node if isinstance(node, list) else []


def slot_host_leaks(adapted: JsonObject, hosts: Sequence[str]) -> list[str]:
    """One line per place a slot hostname appears outside a route host matcher."""
    leaks: list[str] = []
    for path, value in walk(adapted):
        if not isinstance(value, str):
            continue
        for host in hosts:
            allowed = value == host and ROUTE_HOST_MATCHER_PATH.match("/".join(map(str, path))) is not None
            if host in value and not allowed:
                leaks.append(f"{host} appears at {'/'.join(map(str, path))}")
    return leaks


def wildcard_problems(adapted: JsonObject, hosts: Sequence[str]) -> list[str]:
    problems: list[str] = []
    policies = automation_policies(adapted)
    if len(policies) != 1:
        problems.append(f"{len(policies)} TLS automation policies, expected exactly one")
    subjects = managed_subjects(adapted)
    if subjects != [WILDCARD]:
        problems.append(f"managed subjects are {subjects}, expected only {[WILDCARD]}")
    if any(path and path[-1] == "on_demand" for path, _value in walk(adapted)):
        problems.append("on-demand TLS is configured, so any name may be given a certificate")
    return problems + slot_host_leaks(adapted, hosts)


def assert_only_the_wildcard_is_managed(adapted: JsonObject, hosts: Sequence[str]) -> None:
    """Raises WildcardViolation unless the one wildcard is the only name Caddy
    manages and no slot hostname is anywhere but a route host matcher."""
    problems = wildcard_problems(adapted, hosts)
    if problems:
        raise WildcardViolation(problems)


def dns_providers(adapted: JsonObject) -> list[JsonValue]:
    providers: list[JsonValue] = []
    for policy in automation_policies(adapted):
        issuers = policy.get("issuers") if isinstance(policy, dict) else None
        for issuer in issuers if isinstance(issuers, list) else []:
            challenges = issuer.get("challenges") if isinstance(issuer, dict) else None
            dns = challenges.get("dns") if isinstance(challenges, dict) else None
            providers.append(dns.get("provider") if isinstance(dns, dict) else None)
    return providers


def assert_hetzner_provider_with_file_token(adapted: JsonObject, token_path: str) -> None:
    """Raises ProviderViolation unless every issuer solves DNS-01 with the
    Hetzner provider and a token that is exactly a `{file.<token_path>}`
    reference, never a literal value."""
    providers = dns_providers(adapted)
    if not providers:
        raise ProviderViolation("no issuer is configured")
    for provider in providers:
        if not isinstance(provider, dict) or provider.get("name") != "hetzner":
            raise ProviderViolation("an issuer does not use the hetzner DNS provider")
        if provider.get("api_token") != f"{{file.{token_path}}}":
            raise ProviderViolation("the provider token is not a reference to the token file")


def module_is_listed(list_modules_output: str, module: str) -> bool:
    """Whether `module` is a whole line of `caddy list-modules` output."""
    return module in (line.strip() for line in list_modules_output.splitlines())


def edge_for(host: str) -> JsonObject:
    edge: JsonObject = copy.deepcopy(json.loads(GOLDEN.read_text(encoding="utf-8")))
    edge["displayHostname"] = host
    return edge


def render_wildcard_caddyfile(dns_directive: str | None = None, tls: str | None = None) -> str:
    sites = [(str(index), edge_for(host)) for index, host in enumerate(HOSTS)]
    return rds.render_caddyfile(BASE, sites, tls=tls, dns_directive=dns_directive)


def per_host_caddyfile() -> str:
    """The retired form: one `https://<host>` site per slot, each with its
    own certificate."""
    sites = "".join(
        f"https://{host} {{\n\ttls internal\n\treverse_proxy 127.0.0.1:{9300 + index}\n}}\n\n"
        for index, host in enumerate(HOSTS)
    )
    return rde.render() + "\n" + sites


def adapt_rendered(runner: CaddyRunner, make_caddyfile: Callable[[str], str]) -> tuple[JsonObject, str]:
    """Writes the Caddyfile that `make_caddyfile` returns beside a stand-in
    token file holding a fake value, and adapts it. `make_caddyfile` is given
    the token path as Caddy sees it; that path is returned with the JSON."""
    with tempfile.TemporaryDirectory() as name:
        workdir = pathlib.Path(name)
        workdir.chmod(0o755)
        token_path = runner.path_in_caddy(workdir, "dns-token")
        (workdir / "dns-token").write_text(FAKE_TOKEN, encoding="utf-8")
        (workdir / "Caddyfile").write_text(make_caddyfile(token_path), encoding="utf-8")
        return adapt_caddyfile(runner, workdir), token_path


def wildcard_caddyfile(token_path: str) -> str:
    return render_wildcard_caddyfile(dns_directive=f"dns hetzner {{file.{token_path}}}")


def host_route(host: str, routes: list[JsonValue] | None = None) -> JsonObject:
    route: JsonObject = {"match": [{"host": [host]}], "terminal": True}
    if routes is not None:
        route["handle"] = [{"handler": "subroute", "routes": routes}]
    return route


def adapted_json(
    policies: list[JsonValue] | None = None,
    routes: list[JsonValue] | None = None,
    **extra_server: JsonValue,
) -> JsonObject:
    """The shape Caddy adapts the wildcard site to, built by hand for the
    tests of the checks themselves."""
    chosen_policies: list[JsonValue] = [{"subjects": [WILDCARD]}] if policies is None else policies
    chosen_routes: list[JsonValue] = (
        [host_route(WILDCARD, [host_route(host) for host in HOSTS])] if routes is None else routes
    )
    server: JsonObject = {"listen": [":443"], "routes": chosen_routes, **extra_server}
    return {"apps": {"http": {"servers": {"srv0": server}}, "tls": {"automation": {"policies": chosen_policies}}}}


def hetzner_issuer(token: JsonValue, name: str = "hetzner") -> JsonObject:
    provider: JsonObject = {"api_token": token, "name": name}
    return {"issuers": [{"module": "acme", "challenges": {"dns": {"provider": provider}}}]}


class AdaptedChecksTests(unittest.TestCase):
    def violation(self, adapted: JsonObject) -> WildcardViolation:
        with self.assertRaises(WildcardViolation) as caught:
            assert_only_the_wildcard_is_managed(adapted, HOSTS)
        return caught.exception

    def test_the_wildcard_alone_with_slot_hosts_in_nested_route_matchers_passes(self):
        assert_only_the_wildcard_is_managed(adapted_json(), HOSTS)

    def test_a_second_policy_for_a_slot_host_cannot_hide(self):
        adapted = adapted_json(policies=[{"subjects": [WILDCARD]}, {"subjects": [FIRST_HOST]}])
        error = self.violation(adapted)
        self.assertIn(FIRST_HOST, str(error))
        self.assertTrue(any("2 TLS automation policies" in problem for problem in error.problems))

    def test_a_second_policy_without_subjects_is_refused(self):
        self.assertIn("2 TLS automation policies", str(self.violation(adapted_json(policies=[{"subjects": [WILDCARD]}, {}]))))

    def test_a_slot_host_in_a_connection_policy_sni_is_a_managed_name(self):
        adapted = adapted_json(tls_connection_policies=[{"match": {"sni": [SECOND_HOST]}}])
        self.assertIn(SECOND_HOST, str(self.violation(adapted)))

    def test_a_connection_policy_sni_other_than_the_wildcard_is_refused(self):
        adapted = adapted_json(tls_connection_policies=[{"match": {"sni": ["other.example.test"]}}])
        self.assertIn("managed subjects", str(self.violation(adapted)))

    def test_a_connection_policy_sni_of_the_wildcard_alone_is_accepted(self):
        adapted = adapted_json(tls_connection_policies=[{"match": {"sni": [WILDCARD]}}])
        assert_only_the_wildcard_is_managed(adapted, HOSTS)

    def test_on_demand_tls_is_refused(self):
        adapted = adapted_json(policies=[{"subjects": [WILDCARD], "on_demand": True}])
        self.assertIn("on-demand", str(self.violation(adapted)))

    def test_a_slot_host_outside_a_route_host_matcher_is_refused(self):
        route = host_route(WILDCARD, [host_route(FIRST_HOST)])
        route["handle"] = [{"handler": "headers", "response": {"set": {"X-Host": [FIRST_HOST]}}}]
        self.assertIn(FIRST_HOST, str(self.violation(adapted_json(routes=[route]))))

    def test_a_slot_host_inside_a_longer_string_is_refused(self):
        adapted = adapted_json(routes=[host_route(f"x.{FIRST_HOST}")])
        self.assertIn(FIRST_HOST, str(self.violation(adapted)))

    def test_a_slot_host_in_a_route_matcher_outside_the_servers_routes_is_refused(self):
        adapted = adapted_json(errors={"routes": [host_route(FIRST_HOST)]})
        self.assertIn(FIRST_HOST, str(self.violation(adapted)))


class ProviderChecksTests(unittest.TestCase):
    TOKEN_PATH = "/work/dns-token"

    def refused(self, adapted: JsonObject) -> str:
        with self.assertRaises(ProviderViolation) as caught:
            assert_hetzner_provider_with_file_token(adapted, self.TOKEN_PATH)
        return str(caught.exception)

    def test_the_hetzner_provider_with_the_file_reference_passes(self):
        adapted = adapted_json(policies=[hetzner_issuer("{file./work/dns-token}")])
        assert_hetzner_provider_with_file_token(adapted, self.TOKEN_PATH)

    def test_a_literal_token_is_refused(self):
        self.assertIn("token file", self.refused(adapted_json(policies=[hetzner_issuer(FAKE_TOKEN)])))

    def test_an_environment_reference_is_refused_because_the_host_uses_a_file(self):
        self.assertIn("token file", self.refused(adapted_json(policies=[hetzner_issuer("{env.TOKEN}")])))

    def test_a_reference_to_another_file_is_refused(self):
        self.assertIn("token file", self.refused(adapted_json(policies=[hetzner_issuer("{file./etc/other}")])))

    def test_another_provider_is_refused(self):
        adapted = adapted_json(policies=[hetzner_issuer("{file./work/dns-token}", name="cloudflare")])
        self.assertIn("hetzner", self.refused(adapted))

    def test_a_policy_with_no_dns_challenge_is_refused(self):
        adapted = adapted_json(policies=[{"issuers": [{"module": "internal"}]}])
        self.assertIn("hetzner", self.refused(adapted))

    def test_no_issuer_at_all_is_refused(self):
        self.assertIn("no issuer", self.refused(adapted_json(policies=[{"subjects": [WILDCARD]}])))


class ModuleListTests(unittest.TestCase):
    def test_the_module_must_be_a_whole_line(self):
        self.assertTrue(module_is_listed("dns.providers.hetzner\nhttp\n", HETZNER_MODULE))
        self.assertFalse(module_is_listed("dns.providers.hetzner_legacy\nxdns.providers.hetzner\n", HETZNER_MODULE))
        self.assertFalse(module_is_listed("", HETZNER_MODULE))


class RunnerChoiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.built: list[str] = []
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.executable = pathlib.Path(directory.name) / "caddy"
        self.executable.write_text("#!/bin/sh\n", encoding="utf-8")
        self.executable.chmod(0o755)

    def build(self) -> str:
        self.built.append("built")
        return "built-image"

    def choose(self, environ: Mapping[str, str], docker_usable: bool) -> CaddyRunner | None:
        return choose_runner(environ, docker_usable, self.build)

    def test_docker_builds_the_image_and_runs_it(self):
        self.assertEqual(self.choose({}, True), DockerRunner("built-image"))
        self.assertEqual(self.built, ["built"])

    def test_the_binary_override_is_used_locally_without_building(self):
        self.assertEqual(self.choose({CADDY_BINARY_ENV: str(self.executable)}, True), BinaryRunner(str(self.executable)))
        self.assertEqual(self.built, [])

    def test_a_binary_override_that_is_not_an_executable_file_fails_even_locally(self):
        with self.assertRaises(CaddyUnavailable):
            self.choose({CADDY_BINARY_ENV: str(self.executable.parent / "missing")}, True)

    def test_nothing_available_locally_skips(self):
        self.assertIsNone(self.choose({}, False))

    def test_ci_without_docker_fails_instead_of_skipping(self):
        with self.assertRaises(CaddyUnavailable):
            self.choose({"CI": "true"}, False)

    def test_ci_with_the_binary_override_fails_even_with_docker(self):
        with self.assertRaises(CaddyUnavailable):
            self.choose({"CI": "true", CADDY_BINARY_ENV: str(self.executable)}, True)

    def test_ci_with_docker_builds_the_image(self):
        self.assertEqual(self.choose({"CI": "true"}, True), DockerRunner("built-image"))

    def test_an_empty_ci_variable_is_not_ci(self):
        self.assertIsNone(self.choose({"CI": ""}, False))


class RealCaddyCase(unittest.TestCase):
    runner: CaddyRunner

    @classmethod
    def setUpClass(cls) -> None:
        runner = resolve_runner()
        if runner is None:
            raise unittest.SkipTest(f"no Docker and no {CADDY_BINARY_ENV}: the real-Caddy proof did not run (CI fails here)")
        cls.runner = runner


class RealCaddyWildcardTests(RealCaddyCase):
    def test_real_caddy_manages_one_wildcard_subject_and_no_slot_name(self):
        adapted, token_path = adapt_rendered(self.runner, wildcard_caddyfile)
        self.assertEqual(managed_subjects(adapted), [WILDCARD])
        assert_only_the_wildcard_is_managed(adapted, HOSTS)
        assert_hetzner_provider_with_file_token(adapted, token_path)
        self.assertNotIn(FAKE_TOKEN, json.dumps(adapted))

    def test_the_per_host_form_would_be_caught(self):
        adapted, _token_path = adapt_rendered(self.runner, lambda _token_path: per_host_caddyfile())
        self.assertEqual(managed_subjects(adapted), sorted(HOSTS))
        with self.assertRaises(WildcardViolation) as caught:
            assert_only_the_wildcard_is_managed(adapted, HOSTS)
        for host in HOSTS:
            self.assertIn(host, str(caught.exception))

    def test_a_wildcard_site_on_the_local_ca_would_be_caught_as_not_hetzner(self):
        adapted, token_path = adapt_rendered(self.runner, lambda _token_path: render_wildcard_caddyfile(tls="tls internal"))
        assert_only_the_wildcard_is_managed(adapted, HOSTS)
        with self.assertRaises(ProviderViolation):
            assert_hetzner_provider_with_file_token(adapted, token_path)

    def test_a_literal_token_in_the_caddyfile_would_be_caught(self):
        def literal(token_path: str) -> str:
            return wildcard_caddyfile(token_path).replace(f"{{file.{token_path}}}", FAKE_TOKEN)

        adapted, token_path = adapt_rendered(self.runner, literal)
        self.assertIn(FAKE_TOKEN, json.dumps(adapted))
        with self.assertRaises(ProviderViolation):
            assert_hetzner_provider_with_file_token(adapted, token_path)


class DemoEdgeImageTests(RealCaddyCase):
    def test_the_demo_edge_image_registers_the_hetzner_dns_provider(self):
        if not isinstance(self.runner, DockerRunner):
            self.skipTest(f"{CADDY_BINARY_ENV} runs a local binary, not the image built from the Dockerfile")
        with tempfile.TemporaryDirectory() as name:
            listing = run_caddy(self.runner, pathlib.Path(name), ["list-modules"])
        self.assertTrue(module_is_listed(listing.stdout, HETZNER_MODULE))


if __name__ == "__main__":
    unittest.main()
