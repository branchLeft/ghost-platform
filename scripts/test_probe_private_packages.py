"""Tests for probe_private_packages.py, against a fake registry (no network).

Run: python3 -m unittest discover -s scripts -p 'test_probe_private_packages.py' -v
"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import probe_private_packages as probe

REPO_ROOT = Path(__file__).resolve().parent.parent
REAL_IMAGES = REPO_ROOT / ".github" / "image-mirror" / "images.json"
REAL_LIST = REPO_ROOT / ".github" / "image-mirror" / "private-packages.json"
CONTROL = "branchleft/ghost-tenant"
MIRROR_GHOST = "branchleft/mirror/ghost"
DERIVED_RECOVERY = "branchleft/db-recovery"


class FakeRegistry:
    """Answers like the registry: a token for any scope, tags only when served.

    A repo in `served` lists its tags to the anonymous token. A repo in `token_500`
    fails the token request. A repo in `raising` raises on the tags request.
    """

    def __init__(
        self,
        served: set[str],
        token_500: set[str] | None = None,
        raising: set[str] | None = None,
    ) -> None:
        self.served = served
        self.token_500 = token_500 or set()
        self.raising = raising or set()
        self.calls: list[tuple[str, dict[str, str]]] = []

    def get(self, host: str, path: str, headers: dict[str, str]) -> tuple[int, bytes]:
        self.calls.append((path, dict(headers)))
        if path.startswith("/token?"):
            scope = parse_qs(urlsplit(path).query)["scope"][0]
            repo = scope[len("repository:") : -len(":pull")]
            if repo in self.token_500:
                return 500, b""
            return 200, json.dumps({"token": "anon-" + repo}).encode()
        repo = path[len("/v2/") : -len("/tags/list")]
        if repo in self.raising:
            raise OSError("connection reset")
        if headers.get("Authorization") != "Bearer anon-" + repo:
            return 401, b'{"errors":[]}'
        if repo in self.served:
            return 200, b'{"tags":["latest"]}'
        return 404, b'{"errors":[]}'


def run_probe(images: Path, listing: Path, registry: FakeRegistry) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = probe.run(images, listing, registry)
    return code, out.getvalue()


class RealFilesTest(unittest.TestCase):
    def test_green_when_private_refused_and_control_served(self) -> None:
        registry = FakeRegistry(served={CONTROL})
        code, out = run_probe(REAL_IMAGES, REAL_LIST, registry)
        self.assertEqual(code, 0, out)
        self.assertIn("PRIVATE PROBE OK", out)
        self.assertIn("CONTROL served branchleft/ghost-tenant", out)

    def test_red_when_a_private_package_is_served(self) -> None:
        # Sabotage: the mirror-private package is made readable to anyone.
        registry = FakeRegistry(served={CONTROL, MIRROR_GHOST})
        code, out = run_probe(REAL_IMAGES, REAL_LIST, registry)
        self.assertEqual(code, 1, out)
        self.assertIn("served branchleft/mirror/ghost", out)
        self.assertIn("PRIVATE PROBE FAILED", out)

    def test_red_when_a_derived_recovery_image_is_served(self) -> None:
        registry = FakeRegistry(served={CONTROL, DERIVED_RECOVERY})
        code, out = run_probe(REAL_IMAGES, REAL_LIST, registry)
        self.assertEqual(code, 1, out)
        self.assertIn("served branchleft/db-recovery", out)

    def test_red_when_the_control_is_not_served(self) -> None:
        registry = FakeRegistry(served=set())
        code, out = run_probe(REAL_IMAGES, REAL_LIST, registry)
        self.assertEqual(code, 1, out)
        self.assertIn("PROBE BROKEN", out)


class FailClosedTest(unittest.TestCase):
    def test_unknown_token_answer_fails_closed(self) -> None:
        registry = FakeRegistry(served={CONTROL}, token_500={MIRROR_GHOST})
        code, out = run_probe(REAL_IMAGES, REAL_LIST, registry)
        self.assertEqual(code, 1, out)
        self.assertIn("unknown branchleft/mirror/ghost", out)

    def test_network_error_fails_closed(self) -> None:
        registry = FakeRegistry(served={CONTROL}, raising={DERIVED_RECOVERY})
        code, out = run_probe(REAL_IMAGES, REAL_LIST, registry)
        self.assertEqual(code, 1, out)
        self.assertIn("unknown branchleft/db-recovery", out)

    def test_refused_token_counts_as_refused(self) -> None:
        class TokenRefused(FakeRegistry):
            def get(
                self, host: str, path: str, headers: dict[str, str]
            ) -> tuple[int, bytes]:
                if path.startswith("/token?"):
                    scope = parse_qs(urlsplit(path).query)["scope"][0]
                    if scope == f"repository:{MIRROR_GHOST}:pull":
                        self.calls.append((path, dict(headers)))
                        return 401, b""
                return super().get(host, path, headers)

        registry = TokenRefused(served={CONTROL})
        code, out = run_probe(REAL_IMAGES, REAL_LIST, registry)
        self.assertEqual(code, 0, out)
        self.assertIn("refused branchleft/mirror/ghost", out)


class NoCredentialTest(unittest.TestCase):
    def test_token_request_carries_no_header_and_tags_carry_only_the_anonymous_bearer(
        self,
    ) -> None:
        registry = FakeRegistry(served={CONTROL})
        run_probe(REAL_IMAGES, REAL_LIST, registry)
        token_calls = [
            headers for path, headers in registry.calls if path.startswith("/token?")
        ]
        tag_calls = [
            headers for path, headers in registry.calls if path.startswith("/v2/")
        ]
        self.assertTrue(token_calls)
        self.assertTrue(all(headers == {} for headers in token_calls))
        self.assertTrue(all(set(headers) == {"Authorization"} for headers in tag_calls))
        self.assertTrue(
            all(
                headers["Authorization"].startswith("Bearer anon-")
                for headers in tag_calls
            )
        )


class ListValidationTest(unittest.TestCase):
    def write(self, tmp: Path, name: str, data: object) -> Path:
        path = tmp / name
        path.write_text(json.dumps(data))
        return path

    def images(
        self,
        tmp: Path,
        registry: str = "branchleft.example/branchleft/mirror",
        names: tuple[str, ...] = ("ghost",),
    ) -> Path:
        data = {"registry": registry, "images": [{"name": n} for n in names]}
        return self.write(tmp, "images.json", data)

    def listing(
        self,
        tmp: Path,
        mirror: list[str],
        derived: list[str] | None = None,
        control: str = "ghost-tenant",
    ) -> Path:
        return self.write(
            tmp,
            "private.json",
            {
                "mirror": mirror,
                "derived": derived or ["db-recovery"],
                "control": control,
            },
        )

    def test_mirror_name_missing_from_private_list_is_a_list_error(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            images = self.images(tmp, names=("ghost", "newthing"))
            listing = self.listing(tmp, mirror=["ghost"])
            code, out = run_probe(images, listing, FakeRegistry(served={CONTROL}))
        self.assertEqual(code, 2, out)
        self.assertIn("newthing", out)

    def test_registry_without_a_path_is_a_list_error(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            images = self.images(tmp, registry="no-path")
            listing = self.listing(tmp, mirror=["ghost"])
            code, _ = run_probe(images, listing, FakeRegistry(served={CONTROL}))
        self.assertEqual(code, 2)

    def test_control_listed_as_private_is_a_list_error(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            images = self.images(tmp)
            listing = self.listing(
                tmp, mirror=["ghost", "ghost-tenant"], control="ghost-tenant"
            )
            code, _ = run_probe(images, listing, FakeRegistry(served={CONTROL}))
        self.assertEqual(code, 2)

    def test_unreadable_list_is_a_list_error(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            images = self.images(tmp)
            code, _ = run_probe(
                images, tmp / "absent.json", FakeRegistry(served={CONTROL})
            )
        self.assertEqual(code, 2)

    def test_repeated_name_is_a_list_error(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            images = self.images(tmp)
            listing = self.listing(tmp, mirror=["ghost", "ghost"])
            code, _ = run_probe(images, listing, FakeRegistry(served={CONTROL}))
        self.assertEqual(code, 2)

    def test_token_without_a_token_field_is_unknown(self) -> None:
        self.assertIsNone(probe.read_token(b"not json"))
        self.assertIsNone(probe.read_token(b'{"token": ""}'))
        self.assertEqual(probe.read_token(b'{"token": "abc"}'), "abc")


if __name__ == "__main__":
    unittest.main()
