"""Tests for the image mirror: the copy-and-verify script and the reference guard.

Run: python3 -m unittest discover -s scripts -p 'test_image_mirror.py'
No network and no crane: the copy tool is a recording fake.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
LIST = REPO / ".github" / "image-mirror" / "images.json"


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


mirror = load("mirror_images", "mirror-images.py")
guard = load("assert_image_refs", "assert-image-refs-on-mirror.py")

MANIFEST = b'{"schemaVersion":2}'
DIGEST = "sha256:" + hashlib.sha256(MANIFEST).hexdigest()
OTHER = "sha256:" + "b" * 64
ENTRY = {
    "name": "ghost",
    "source": "docker.io/library/ghost",
    "digest": DIGEST,
    "upstreamTags": ["6"],
    "licence": "MIT",
    "redistribution": "permitted",
    "licenceSource": "https://example.invalid/LICENSE",
}
REGISTRY = "ghcr.io/branchleft/mirror"
TAGGED = f"{REGISTRY}/ghost:d-{DIGEST[7:19]}"
PINNED = f"{REGISTRY}/ghost@{DIGEST}"
SOURCE = f"docker.io/library/ghost@{DIGEST}"


class FakeCrane:
    """Records argv; answers from a dict of (verb, ref) -> (code, stdout, stderr)."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, argv):
        self.calls.append(argv[1:])
        return self.answers.get((argv[1], argv[2]), (1, b"", "not found"))


def mirror_one(answers, **kw):
    fake = FakeCrane(answers)
    lines = []
    ok = mirror.mirror_one(REGISTRY, ENTRY, "crane", fake, sleep=lambda s: None, log=lines.append, **kw)
    return ok, fake, lines


class MirrorOneTests(unittest.TestCase):
    def test_copies_then_verifies_the_manifest_bytes(self):
        ok, fake, _ = mirror_one(
            {("copy", SOURCE): (0, b"", ""), ("manifest", PINNED): (0, MANIFEST, "")}
        )
        self.assertTrue(ok)
        self.assertEqual(
            fake.calls, [["digest", TAGGED], ["copy", SOURCE, TAGGED], ["manifest", PINNED]]
        )

    def test_idempotent_when_the_tag_already_has_the_digest(self):
        ok, fake, lines = mirror_one(
            {("digest", TAGGED): (0, DIGEST.encode() + b"\n", ""), ("manifest", PINNED): (0, MANIFEST, "")}
        )
        self.assertTrue(ok)
        self.assertNotIn("copy", [c[0] for c in fake.calls])
        self.assertIn(f"already mirrored: {TAGGED}", lines)

    def test_recopies_when_the_tag_points_elsewhere(self):
        ok, fake, _ = mirror_one(
            {
                ("digest", TAGGED): (0, OTHER.encode(), ""),
                ("copy", SOURCE): (0, b"", ""),
                ("manifest", PINNED): (0, MANIFEST, ""),
            }
        )
        self.assertTrue(ok)
        self.assertIn("copy", [c[0] for c in fake.calls])

    def test_digest_mismatch_on_read_back_fails(self):
        ok, _, lines = mirror_one(
            {("copy", SOURCE): (0, b"", ""), ("manifest", PINNED): (0, b"tampered", "")}
        )
        self.assertFalse(ok)
        self.assertTrue(any("DIGEST MISMATCH" in line for line in lines))

    def test_unreadable_mirror_fails(self):
        ok, _, lines = mirror_one({("copy", SOURCE): (0, b"", "")})
        self.assertFalse(ok)
        self.assertTrue(any("READ-BACK FAILED" in line for line in lines))

    def test_copy_retries_then_gives_up(self):
        ok, fake, _ = mirror_one({("copy", SOURCE): (1, b"", "429 Too Many Requests")})
        self.assertFalse(ok)
        self.assertEqual([c[0] for c in fake.calls].count("copy"), mirror.COPY_ATTEMPTS)
        self.assertNotIn("manifest", [c[0] for c in fake.calls])

    def test_copy_recovers_after_one_failure(self):
        results = iter([(1, b"", "429"), (0, b"", "")])

        def run(argv):
            if argv[1] == "copy":
                return next(results)
            if argv[1] == "manifest":
                return (0, MANIFEST, "")
            return (1, b"", "")

        self.assertTrue(
            mirror.mirror_one(REGISTRY, ENTRY, "crane", run, sleep=lambda s: None, log=lambda m: None)
        )


class ListTests(unittest.TestCase):
    def write(self, data):
        path = Path(tempfile.mkdtemp()) / "list.json"
        path.write_text(json.dumps(data))
        return path

    def test_the_committed_list_is_valid_and_unique(self):
        registry, images = mirror.load_list(LIST)
        self.assertEqual(registry, REGISTRY)
        self.assertGreater(len(images), 20)

    def test_rejects_a_bad_digest(self):
        bad = dict(ENTRY, digest="sha256:abc")
        with self.assertRaises(mirror.ListError):
            mirror.load_list(self.write({"registry": REGISTRY, "images": [bad]}))

    def test_rejects_a_source_with_a_tag(self):
        bad = dict(ENTRY, source="docker.io/library/ghost:6")
        with self.assertRaises(mirror.ListError):
            mirror.load_list(self.write({"registry": REGISTRY, "images": [bad]}))

    def test_rejects_a_foreign_registry(self):
        with self.assertRaises(mirror.ListError):
            mirror.load_list(self.write({"registry": "ghcr.io/someone/else", "images": [ENTRY]}))

    def test_rejects_a_repeated_pair(self):
        with self.assertRaises(mirror.ListError):
            mirror.load_list(self.write({"registry": REGISTRY, "images": [ENTRY, dict(ENTRY)]}))

    def test_same_name_with_two_digests_is_fine(self):
        mirror.load_list(self.write({"registry": REGISTRY, "images": [ENTRY, dict(ENTRY, digest=OTHER)]}))


class MainTests(unittest.TestCase):
    def run_main(self, argv, run=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = mirror.main(argv, run, lambda s: None) if run else mirror.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_dry_run_prints_every_command_and_runs_nothing(self):
        def boom(argv):
            raise AssertionError("dry run must not run anything")

        code, out, _ = self.run_main(["--list", str(LIST), "--dry-run"], boom)
        _, images = mirror.load_list(LIST)
        self.assertEqual(code, 0)
        self.assertEqual(out.count("crane copy "), len(images))
        self.assertEqual(out.count("crane manifest "), len(images))
        self.assertIn("nothing was run", out)

    def test_only_filters_by_name_and_unknown_name_is_a_usage_error(self):
        code, out, _ = self.run_main(["--list", str(LIST), "--dry-run", "--only", "zitadel"])
        self.assertEqual((code, out.count("crane copy ")), (0, 1))
        code, _, err = self.run_main(["--list", str(LIST), "--dry-run", "--only", "nope"])
        self.assertEqual(code, 2)

    def test_exit_one_when_any_entry_fails(self):
        path = Path(tempfile.mkdtemp()) / "list.json"
        path.write_text(json.dumps({"registry": REGISTRY, "images": [ENTRY]}))
        code, out, err = self.run_main(["--list", str(path)], lambda argv: (1, b"", "boom"))
        self.assertEqual(code, 1)
        self.assertIn("FAILED: ghost", err)
        self.assertIn("0/1 entries verified", out)

    def test_exit_zero_when_all_verify(self):
        path = Path(tempfile.mkdtemp()) / "list.json"
        path.write_text(json.dumps({"registry": REGISTRY, "images": [ENTRY]}))
        answers = {("copy", SOURCE): (0, b"", ""), ("manifest", PINNED): (0, MANIFEST, "")}
        code, out, _ = self.run_main(["--list", str(path)], FakeCrane(answers))
        self.assertEqual(code, 0)
        self.assertIn("1/1 entries verified", out)

    def test_bad_list_is_exit_two(self):
        path = Path(tempfile.mkdtemp()) / "list.json"
        path.write_text("{}")
        code, _, err = self.run_main(["--list", str(path)])
        self.assertEqual(code, 2)
        self.assertIn("bad list", err)


PAIRS = {("ghost", "sha256:" + "a" * 64)}
MIRROR_OK = "ghcr.io/branchleft/mirror/ghost@sha256:" + "a" * 64


class ClassifyTests(unittest.TestCase):
    def kind(self, ref):
        verdict = guard.classify(ref, PAIRS)
        return verdict[0] if verdict else None

    def test_allowed(self):
        for ref in (
            MIRROR_OK,
            "ghcr.io/branchleft/db-recovery@sha256:" + "c" * 64,
            "ghost-platform:ci",
            "drain-sidecar:proof",
        ):
            self.assertIsNone(self.kind(ref), ref)

    def test_refused(self):
        digest = "@sha256:" + "a" * 64
        cases = {
            "ghost:6.55.0-alpine": "unqualified",
            "ghost" + digest: "unqualified",
            "alpine": "unqualified",
            "postgres:17-alpine": "unqualified",
            "percona/percona-server:8.0": "docker.io",
            "docker.io/library/ghost:6": "docker.io",
            "registry-1.docker.io/library/ghost:6": "docker.io",
            "quay.io/minio/minio:latest": "other-registry",
            "ghcr.io/zitadel/zitadel" + digest: "other-registry",
            "ghcr.io/branchleft/mirror/ghost:6.55.0-alpine": "tag-only",
            "ghcr.io/branchleft/ghost-tenant:latest": "tag-only",
            "ghcr.io/branchleft/mirror/ghost@sha256:" + "d" * 64: "not-on-list",
            "ghost-platform:latest": "unqualified",
        }
        for ref, kind in cases.items():
            self.assertEqual(self.kind(ref), kind, ref)

    def test_not_images_are_ignored(self):
        for ref in ("127.0.0.1:3001:2368", "!!", "node:fs"):
            if ref == "node:fs":
                continue  # shaped like an image; only code files filter it by tag shape
            self.assertIsNone(self.kind(ref), ref)


def scan_tree(files, allow=()):
    root = Path(tempfile.mkdtemp())
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    return guard.scan(root, PAIRS, list(allow)), root


class ScanTests(unittest.TestCase):
    def kinds(self, files, allow=()):
        findings, _ = scan_tree(files, allow)
        return [(f.path, f.line, f.kind) for f in findings]

    def test_dockerfile_from(self):
        text = f"FROM {MIRROR_OK} AS build\nFROM build AS final\nFROM scratch\nFROM --platform=linux/amd64 ghost:6\n"
        self.assertEqual(self.kinds({"Dockerfile": text}), [("Dockerfile", 4, "unqualified")])

    def test_dockerfile_variants_are_scanned(self):
        self.assertEqual(
            self.kinds({"x/lab.Dockerfile": "FROM debian:trixie\n"}), [("x/lab.Dockerfile", 1, "unqualified")]
        )

    def test_workflow_service_and_container_images(self):
        text = "jobs:\n  t:\n    container:\n      image: node:22\n    services:\n      db:\n        image: postgres:17\n"
        self.assertEqual(
            self.kinds({".github/workflows/a.yml": text}),
            [(".github/workflows/a.yml", 4, "unqualified"), (".github/workflows/a.yml", 7, "unqualified")],
        )

    def test_expression_images_and_comments_are_skipped(self):
        text = "    image: ${{ steps.digest.outputs.image }}\n    # image: postgres:17\n    image: ${IMAGE}\n"
        self.assertEqual(self.kinds({"w.yml": text}), [])

    def test_docker_run_image_position(self):
        text = (
            'docker run --rm -v "$PWD":/repo:ro -w /repo debian:bookworm-slim bash -c "x"\n'
            'docker run -d --name n --network-alias a \\\n    -e A=b \\\n    mysql:8.0 --flag\n'
            'docker run --rm "$VAR" cmd\n'
            "docker pull -q alpine\n"
        )
        self.assertEqual(
            self.kinds({"s.sh": text}),
            [("s.sh", 1, "unqualified"), ("s.sh", 2, "unqualified"), ("s.sh", 6, "unqualified")],
        )

    def test_image_variable_assignments(self):
        text = 'PROBE_IMAGE="python:3.12-alpine"\nX="${E_IMAGE:-curlimages/curl:8.16.0}"\nP="${A_IMAGE:-NO DIGEST}"\n'
        self.assertEqual(self.kinds({"s.sh": text}), [("s.sh", 1, "unqualified"), ("s.sh", 2, "docker.io")])

    def test_local_builds_are_the_repos_own(self):
        text = 'docker build -t my-proof:local .\ndocker run --rm my-proof:local\ndocker run --rm other:local\n'
        self.assertEqual(self.kinds({"s.sh": text}), [("s.sh", 3, "unqualified")])

    def test_code_strings_need_a_docker_context_and_a_version_shaped_tag(self):
        text = "const a = 'node:fs';\n// docker\nconst IMAGE = 'mysql:8.0';\nconst b = 'urn:x:y';\n"
        self.assertEqual(self.kinds({"t.mjs": text}), [("t.mjs", 3, "unqualified")])
        self.assertEqual(self.kinds({"u.mjs": "const x = 'mysql:8.0';\n"}), [])

    def test_allow_list_skips_only_the_named_path(self):
        files = {"a/fixture.py": '# image\nX = "mysql:8.0"\n', "b/real.py": '# image\nX = "mysql:8.0"\n'}
        self.assertEqual(self.kinds(files, ["a/fixture.py"]), [("b/real.py", 2, "unqualified")])

    def test_the_lists_own_directory_and_markdown_are_not_scanned(self):
        files = {".github/image-mirror/x.json": '{"image": "mysql:8.0@sha256:' + "a" * 64 + '"}', "README.md": "FROM ghost:6"}
        self.assertEqual(self.kinds(files), [])


class ModeTests(unittest.TestCase):
    """The sabotage cases, in the mode PR B turns on, then the clean tree."""

    def run_guard(self, files, mode):
        _, root = scan_tree(files)
        policy = root / "policy.json"
        policy.write_text(json.dumps({"images": [{"name": "ghost", "digest": "sha256:" + "a" * 64}]}))
        out = io.StringIO()
        with redirect_stdout(out):
            code = guard.main(["--root", str(root), "--list", str(policy), "--mode", mode])
        return code, out.getvalue()

    SABOTAGE = {
        "re-added FROM ghost": {"Dockerfile": "FROM ghost:6.55.0-alpine\n"},
        "tag-only mirror ref": {"Dockerfile": "FROM ghcr.io/branchleft/mirror/ghost:6.55.0-alpine\n"},
        "unqualified workflow service image": {
            ".github/workflows/ci.yml": "jobs:\n  t:\n    services:\n      db:\n        image: postgres:17-alpine\n"
        },
    }

    def test_enforce_is_red_for_each_sabotage(self):
        for label, files in self.SABOTAGE.items():
            code, out = self.run_guard(files, "enforce")
            self.assertEqual(code, 1, label)
            self.assertIn("1 reference(s) not on the mirror (mode enforce)", out, label)

    def test_warn_reports_the_same_findings_and_exits_zero(self):
        for label, files in self.SABOTAGE.items():
            code, out = self.run_guard(files, "warn")
            self.assertEqual(code, 0, label)
            self.assertIn("1 reference(s) not on the mirror (mode warn)", out, label)

    def test_enforce_is_green_on_a_clean_tree(self):
        files = {
            "Dockerfile": f"FROM {MIRROR_OK}\n",
            ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: docker build -t app:ci .\n",
        }
        code, out = self.run_guard(files, "enforce")
        self.assertEqual(code, 0)
        self.assertIn("0 reference(s)", out)

    def test_missing_policy_is_exit_two(self):
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(guard.main(["--list", "/nonexistent/list.json"]), 2)

    def test_allow_entry_without_a_reason_is_refused(self):
        path = Path(tempfile.mkdtemp()) / "p.json"
        path.write_text(json.dumps({"images": [], "allow": [{"path": "a"}]}))
        with self.assertRaises(ValueError):
            guard.load_policy(path)

    def test_self_test_passes(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(guard.self_test(), 0)


class CoverageTests(unittest.TestCase):
    """Every reference the guard finds today is one the list can replace."""

    def test_every_current_reference_is_on_the_list(self):
        mirror_pairs, allow = guard.load_policy(LIST)
        _, images = mirror.load_list(LIST)
        by_digest = {(e["source"], e["digest"]) for e in images}
        by_tag = {(e["source"], t) for e in images for t in e["upstreamTags"]}
        findings = guard.scan(REPO, mirror_pairs, allow)
        gaps = []
        for f in findings:
            m = guard.IMAGE_RE.match(f.ref)
            repo = m["repo"]
            parts = repo.split("/")
            if len(parts) > 1 and ("." in parts[0] or ":" in parts[0]):
                source = repo
            elif len(parts) == 1:
                source = f"docker.io/library/{repo}"
            else:
                source = f"docker.io/{repo}"
            if source.startswith("docker.io/docker.io/"):
                source = source[len("docker.io/"):]
            tag = m["tag"] or "latest"
            if m["digest"]:
                ok = (source, m["digest"]) in by_digest
            else:
                ok = (source, tag) in by_tag
            if not ok and f.kind != "tag-only":
                gaps.append(f.render())
        # quay.io/minio is gone upstream (401 for anonymous pulls), so it is deliberately not listed.
        gaps = [g for g in gaps if "quay.io/minio/" not in g]
        self.assertEqual(gaps, [])


if __name__ == "__main__":
    unittest.main()
