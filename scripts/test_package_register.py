"""Tests for the package register check: every name a workflow or the mirror manifest uses must be registered."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "package_register", REPO / "scripts" / "package_register.py"
)
assert SPEC is not None and SPEC.loader is not None
package_register = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package_register)


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def tree(
    workflows: dict[str, str], register: list[dict[str, str]], images: list[str]
) -> Path:
    root = Path(tempfile.mkdtemp(prefix="pkgreg-"))
    for name, body in workflows.items():
        write(root, f".github/workflows/{name}", body)
    write(root, "registers/packages.json", json.dumps({"packages": register}))
    write(
        root,
        ".github/image-mirror/images.json",
        json.dumps(
            {
                "registry": "ghcr.io/branchleft/mirror-private2",
                "images": [{"name": n} for n in images],
            }
        ),
    )
    return root


class PackageRegisterTests(unittest.TestCase):
    def test_repository_tree_passes(self) -> None:
        register = package_register.load_register(REPO / "registers" / "packages.json")
        self.assertEqual(package_register.problems(REPO, register), [])

    def test_unregistered_workflow_name_is_a_problem(self) -> None:
        root = tree(
            {"x.yml": "env:\n  IMAGE: ghcr.io/branchleft/new-thing\n"},
            [],
            [],
        )
        register = package_register.load_register(root / "registers" / "packages.json")
        found = package_register.problems(root, register)
        self.assertEqual(len(found), 1)
        self.assertIn("new-thing", found[0])

    def test_registered_workflow_name_passes(self) -> None:
        root = tree(
            {"x.yml": "env:\n  IMAGE: ghcr.io/branchleft/new-thing@sha256:abc\n"},
            [{"name": "new-thing", "visibility": "public"}],
            [],
        )
        register = package_register.load_register(root / "registers" / "packages.json")
        self.assertEqual(package_register.problems(root, register), [])

    def test_dynamic_mirror_target_is_not_read_as_a_name(self) -> None:
        root = tree(
            {
                "x.yml": "run: crane copy src ghcr.io/branchleft/mirror-private2/${name}\n"
            },
            [],
            [],
        )
        register = package_register.load_register(root / "registers" / "packages.json")
        self.assertEqual(package_register.problems(root, register), [])

    def test_unregistered_mirror_name_is_a_problem(self) -> None:
        root = tree({}, [], ["newimage"])
        register = package_register.load_register(root / "registers" / "packages.json")
        found = package_register.problems(root, register)
        self.assertEqual(
            found, ["mirror-private2/newimage: in images.json but not on the register"]
        )

    def test_duplicate_register_entry_is_refused(self) -> None:
        root = tree(
            {},
            [
                {"name": "a", "visibility": "public"},
                {"name": "a", "visibility": "public"},
            ],
            [],
        )
        with self.assertRaises(ValueError):
            package_register.load_register(root / "registers" / "packages.json")

    def test_bad_visibility_is_refused(self) -> None:
        root = tree({}, [{"name": "a", "visibility": "internal"}], [])
        with self.assertRaises(ValueError):
            package_register.load_register(root / "registers" / "packages.json")


if __name__ == "__main__":
    unittest.main()
