"""Tests for sweep-tenant-state-secrets.py. No network: the lister and the
enumerator are injected, so every case runs offline."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest


def _load():
    path = pathlib.Path(__file__).resolve().parent / "sweep-tenant-state-secrets.py"
    spec = importlib.util.spec_from_file_location("sweep_tenant_state_secrets", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


sweep = _load()
OLD = "HETZNER_S3_ACCESS_KEY_ID"
BLOG = sweep.TENANT_ZERO
ACME = "org/acme-site"
SCRATCH = "org/scratch-sweep-control"


class World:
    """An injected view of GitHub: which repos exist and what each holds."""

    def __init__(self, held: dict[str, list[str] | Exception]) -> None:
        self.held = held
        self.reads: list[str] = []

    def lister(self, repo: str) -> list[str]:
        self.reads.append(repo)
        value = self.held[repo]
        if isinstance(value, Exception):
            raise value
        return value

    def enumerator(self) -> list[str]:
        return [r for r in self.held if r != SCRATCH]


def run(world: World, *argv: str, enumerator=None) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = sweep.main(
            list(argv),
            lister=world.lister,
            enumerator=enumerator or world.enumerator,
        )
    return code, out.getvalue()


def clean_world() -> World:
    return World({BLOG: ["PULUMI_ENCRYPTION_SALT", "STATE_GATEWAY_ACCESS_KEY_ID"], ACME: ["STATE_GATEWAY_ACCESS_KEY_ID"], SCRATCH: [OLD]})


class TheSweepFindsTheOldKey(unittest.TestCase):
    def test_a_clean_estate_is_green_and_prints_how_many_repos_it_read(self):
        code, out = run(clean_world(), "--register-count", "2")
        self.assertEqual(code, sweep.EXIT_CLEAN, out)
        self.assertIn("read 2 tenant repositories", out)

    def test_a_tenant_repo_holding_the_old_name_is_red_and_named(self):
        world = clean_world()
        world.held[ACME] = ["HETZNER_S3_SECRET_ACCESS_KEY"]
        code, out = run(world, "--register-count", "2")
        self.assertEqual(code, sweep.EXIT_FOUND)
        self.assertIn(f"FOUND {ACME} lists HETZNER_S3_SECRET_ACCESS_KEY", out)

    def test_tenant_zero_is_always_read_even_if_the_enumeration_misses_it(self):
        world = clean_world()
        code, out = run(world, "--register-count", "1", enumerator=lambda: [ACME])
        self.assertEqual(code, sweep.EXIT_COUNT, out)
        self.assertIn(BLOG, world.reads)


class TheSeededControl(unittest.TestCase):
    def test_the_seeded_scratch_repo_is_reported_by_name_and_the_run_stays_green(self):
        code, out = run(clean_world(), "--register-count", "2", "--control-repo", SCRATCH)
        self.assertEqual(code, sweep.EXIT_CLEAN, out)
        self.assertIn(f"control {SCRATCH}: reported", out)

    def test_the_same_scratch_repo_among_the_tenants_is_the_red(self):
        world = clean_world()
        world.held[ACME] = [OLD]
        code, out = run(world, "--register-count", "2", "--control-repo", SCRATCH)
        self.assertEqual(code, sweep.EXIT_FOUND)
        self.assertIn(f"FOUND {ACME}", out)

    def test_a_control_that_is_not_reported_means_the_sweep_is_blind(self):
        world = clean_world()
        world.held[SCRATCH] = ["SOMETHING_ELSE"]
        code, out = run(world, "--register-count", "2", "--control-repo", SCRATCH)
        self.assertEqual(code, sweep.EXIT_BLIND, out)
        self.assertIn(f"CONTROL NOT REPORTED {SCRATCH}", out)

    def test_a_control_is_not_counted_as_a_tenant(self):
        world = clean_world()
        code, out = run(world, "--register-count", "2", "--control-repo", SCRATCH)
        self.assertEqual(code, sweep.EXIT_CLEAN, out)
        self.assertIn("read 2 tenant repositories", out)


class TheCountIsCrossChecked(unittest.TestCase):
    def test_fewer_repos_read_than_the_register_counts_fails(self):
        code, out = run(clean_world(), "--register-count", "3")
        self.assertEqual(code, sweep.EXIT_COUNT)
        self.assertIn("COUNT DIFFERS: read 2, register 3", out)

    def test_more_repos_read_than_the_register_counts_fails(self):
        code, out = run(clean_world(), "--register-count", "1")
        self.assertEqual(code, sweep.EXIT_COUNT)
        self.assertIn("COUNT DIFFERS", out)

    def test_the_count_can_come_from_a_names_register(self):
        document = {"names": [{"name": "website", "kind": "infrastructure"}, {"name": "blog", "kind": "tenant", "repo": BLOG}, {"name": "acme", "kind": "tenant", "repo": ACME}]}
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "register.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            code, out = run(clean_world(), "--register", str(path))
        self.assertEqual(code, sweep.EXIT_CLEAN, out)


class AnUnreadableRepoIsNeverNoneFound(unittest.TestCase):
    def test_a_permission_failure_is_reported_as_cannot_read(self):
        world = clean_world()
        world.held[ACME] = sweep.CannotRead(ACME, "HTTP 403")
        code, out = run(world, "--register-count", "2")
        self.assertEqual(code, sweep.EXIT_CANNOT_READ)
        self.assertIn(f"CANNOT READ {ACME}: HTTP 403", out)
        self.assertNotIn("clean:", out)
        self.assertIn("not 'none found'", out)

    def test_every_repo_unreadable_never_prints_clean(self):
        world = clean_world()
        world.held[BLOG] = sweep.CannotRead(BLOG, "HTTP 403")
        world.held[ACME] = sweep.CannotRead(ACME, "HTTP 403")
        code, out = run(world, "--register-count", "2")
        self.assertEqual(code, sweep.EXIT_CANNOT_READ)
        self.assertNotIn("clean:", out)

    def test_an_unreadable_control_is_cannot_read_not_blind_and_not_green(self):
        world = clean_world()
        world.held[SCRATCH] = sweep.CannotRead(SCRATCH, "HTTP 404")
        code, out = run(world, "--register-count", "2", "--control-repo", SCRATCH)
        self.assertEqual(code, sweep.EXIT_CANNOT_READ)
        self.assertIn(f"CANNOT READ {SCRATCH}", out)

    def test_a_failed_enumeration_is_cannot_read(self):
        def refuse() -> list[str]:
            raise sweep.CannotRead("repo list", "HTTP 401")

        code, out = run(clean_world(), "--register-count", "2", enumerator=refuse)
        self.assertEqual(code, sweep.EXIT_CANNOT_READ)
        self.assertIn("CANNOT READ the repository list", out)


class TheCommandLine(unittest.TestCase):
    def test_the_register_and_the_count_are_exclusive(self):
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(io.StringIO()):
            sweep.main(["--register", "x", "--register-count", "1"], lister=lambda r: [], enumerator=lambda: [])
        self.assertEqual(raised.exception.code, sweep.EXIT_USAGE)

    def test_the_self_test_passes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sweep.main(["--self-test"]), sweep.EXIT_CLEAN)

    def test_only_old_names_are_ever_printed(self):
        world = clean_world()
        world.held[ACME] = [OLD, "PULUMI_CONFIG_PASSPHRASE"]
        _, out = run(world, "--register-count", "2")
        self.assertNotIn("PULUMI_CONFIG_PASSPHRASE", out)


if __name__ == "__main__":
    unittest.main()
