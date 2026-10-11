"""Tests for the image mirror: the copy-and-verify script and the reference guard.

Run: python3 -m unittest discover -s scripts -p 'test_image_mirror.py'
No network and no crane: the copy tool is a recording fake.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import io
import json
import re
import sys
import tempfile
import time
import tokenize
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

    def test_rejects_a_malformed_host_pin_list(self):
        bad = dict(ENTRY, hostPins="ops1")
        with self.assertRaises(mirror.ListError):
            mirror.load_list(self.write({"registry": REGISTRY, "images": [bad]}))

    def test_the_ops1_break_glass_pin_is_on_the_list(self):
        _, images = mirror.load_list(LIST)
        pinned = [e for e in images if any("break-glass minter" in p for p in e.get("hostPins", []))]
        self.assertEqual([e["name"] for e in pinned], ["node"])
        self.assertTrue(pinned[0]["digest"].startswith("sha256:2d49d876"))

    def test_rejects_a_name_that_is_not_the_sources_last_component(self):
        bad = dict(ENTRY, name="ghosty")
        with self.assertRaises(mirror.ListError):
            mirror.load_list(self.write({"registry": REGISTRY, "images": [bad]}))

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


PAIRS = {("docker.io/library/ghost", "sha256:" + "a" * 64)}
MIRROR_OK = "${IMAGE_REGISTRY:-docker.io/library}/ghost:6@sha256:" + "a" * 64
HARD_CODED = "ghcr.io/branchleft/mirror/ghost@sha256:" + "a" * 64


class ClassifyTests(unittest.TestCase):
    LOCAL = frozenset({"ghost-platform:ci", "drain-sidecar:proof"})

    def kind(self, ref, local=frozenset()):
        verdict = guard.classify(ref, PAIRS, local)
        return verdict[0] if verdict else None

    def test_allowed(self):
        for ref in (MIRROR_OK, "ghcr.io/branchleft/db-recovery:v1@sha256:" + "c" * 64):
            self.assertIsNone(self.kind(ref), ref)
        for ref in self.LOCAL:
            self.assertIsNone(self.kind(ref, self.LOCAL), ref)

    def test_a_ci_or_proof_tag_is_not_allowed_unless_the_tree_builds_it(self):
        for ref in ("ghost-platform:ci", "drain-sidecar:proof", "postgres:ci"):
            self.assertEqual(self.kind(ref), "unqualified", ref)
        self.assertEqual(self.kind("postgres:ci", self.LOCAL), "unqualified")

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
            "ghcr.io/branchleft/mirror/ghost:6.55.0-alpine": "hard-coded-mirror",
            HARD_CODED: "hard-coded-mirror",
            "${IMAGE_REGISTRY:-docker.io/library}/ghost:6.55.0-alpine": "tag-only",
            "${IMAGE_REGISTRY:-docker.io/library}/ghost@sha256:" + "d" * 64: "bad-default",
            "${IMAGE_REGISTRY:-docker.io/other}/ghost@sha256:" + "a" * 64: "bad-default",
            "${IMAGE_REGISTRY}/ghost@sha256:" + "a" * 64: "bad-default",
            "ghcr.io/branchleft/ghost-tenant:latest": "tag-only",
            "ghost-platform:latest": "unqualified",
            "203.0.113.9:5000/evil/img:1": "other-registry",
            "203.0.113.9/evil/img:latest": "other-registry",
            "localhost:5000/evil/img:1": "other-registry",
            "ghcr.io/branchleft/db-recovery@sha256:" + "c" * 64: "no-tag",
            "${IMAGE_REGISTRY:-docker.io/library}/ghost@sha256:" + "a" * 64: "no-tag",
        }
        for ref, kind in cases.items():
            self.assertEqual(self.kind(ref), kind, ref)

    def test_not_images_are_ignored(self):
        for ref in ("127.0.0.1:3001:2368", "127.0.0.1:3001", "!!", "1.2.3"):
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

    def test_expression_images_are_unresolved_and_comments_are_skipped(self):
        text = "    image: ${{ matrix.image }}\n    # image: postgres:17\n    image: ${IMAGE}\n"
        self.assertEqual(
            self.kinds({"w.yml": text}), [("w.yml", 1, "unresolved"), ("w.yml", 3, "unresolved")]
        )

    def test_an_outputs_mapping_hands_a_value_on_and_pulls_nothing(self):
        text = "jobs:\n  t:\n    outputs:\n      image: ${{ steps.digest.outputs.image }}\n"
        self.assertEqual(self.kinds({".github/workflows/w.yml": text}), [])

    def test_docker_run_image_position(self):
        text = (
            'docker run --rm -v "$PWD":/repo:ro -w /repo debian:bookworm-slim bash -c "x"\n'
            'docker run -d --name n --network-alias a \\\n    -e A=b \\\n    mysql:8.0 --flag\n'
            'docker run --rm "$VAR" cmd\n'
            "docker pull -q alpine\n"
        )
        self.assertEqual(
            self.kinds({"s.sh": text}),
            [("s.sh", 1, "unqualified"), ("s.sh", 2, "unqualified"), ("s.sh", 5, "unresolved"), ("s.sh", 6, "unqualified")],
        )

    def test_image_variable_assignments(self):
        text = 'PROBE_IMAGE="python:3.12-alpine"\nX="${E_IMAGE:-curlimages/curl:8.16.0}"\nP="${A_IMAGE:-NO DIGEST}"\n'
        self.assertEqual(self.kinds({"s.sh": text}), [("s.sh", 1, "unqualified"), ("s.sh", 2, "docker.io")])

    def test_local_builds_are_the_repos_own(self):
        text = 'docker build -t my-proof:local .\ndocker run --rm my-proof:local\ndocker run --rm other:local\n'
        self.assertEqual(self.kinds({"s.sh": text}), [("s.sh", 3, "unqualified")])

    def test_code_strings_need_a_version_shaped_tag(self):
        text = "const a = 'node:fs';\n// docker\nconst IMAGE = 'mysql:8.0';\nconst b = 'urn:x:y';\nconst c = 'db:3306';\n"
        self.assertEqual(self.kinds({"t.mjs": text}), [("t.mjs", 3, "unqualified")])
        self.assertEqual(self.kinds({"u.mjs": "const x = 'foo:1.2';\n"}), [])

    def test_allow_list_skips_only_the_named_path(self):
        files = {"a/fixture.py": '# image\nX = "mysql:8.0"\n', "b/real.py": '# image\nX = "mysql:8.0"\n'}
        self.assertEqual(self.kinds(files, ["a/fixture.py"]), [("b/real.py", 2, "unqualified")])

    def test_the_lists_own_directory_and_markdown_are_not_scanned(self):
        files = {".github/image-mirror/x.json": '{"image": "mysql:8.0@sha256:' + "a" * 64 + '"}', "README.md": "FROM ghost:6"}
        self.assertEqual(self.kinds(files), [])


class LocalDevelopmentTests(unittest.TestCase):
    """The variable form keeps a local build credential-free and on the same bytes."""

    def test_shell_and_compose_forms_with_a_public_default_are_clean(self):
        digest = "sha256:" + "a" * 64
        files = {
            "s.sh": f'GHOST_IMAGE="${{IMAGE_REGISTRY:-docker.io/library}}/ghost:6@{digest}"\n'
            f'docker run --rm "${{IMAGE_REGISTRY:-docker.io/library}}/ghost:6@{digest}" true\n',
            "compose.yml": f"services:\n  a:\n    image: ${{IMAGE_REGISTRY:-docker.io/library}}/ghost:6@{digest}\n",
        }
        self.assertEqual(ScanTests().kinds(files), [])

    def test_a_variable_without_a_public_default_is_refused(self):
        digest = "sha256:" + "a" * 64
        files = {"compose.yml": f"services:\n  a:\n    image: ${{IMAGE_REGISTRY}}/ghost@{digest}\n"}
        self.assertEqual(ScanTests().kinds(files), [("compose.yml", 3, "bad-default")])

    def test_the_pilot_dockerfile_uses_the_variable_form_and_is_clean(self):
        text = (REPO / "widgets" / "origin" / "Dockerfile").read_text()
        self.assertIn("FROM ${IMAGE_REGISTRY:-docker.io/library}/caddy:2-alpine@sha256:", text)
        root = Path(tempfile.mkdtemp())
        (root / "Dockerfile").write_text(text)
        mirror_pairs, allow = guard.load_policy(LIST)
        self.assertEqual([f.render() for f in guard.scan(root, mirror_pairs, allow)], [])

    def test_the_pilot_default_is_the_public_source_of_a_listed_digest(self):
        text = (REPO / "widgets" / "origin" / "Dockerfile").read_text()
        ref = text.split("FROM ", 1)[1].split()[0]
        mirror_pairs, _ = guard.load_policy(LIST)
        self.assertIsNone(guard.classify(ref, mirror_pairs))


class ModeTests(unittest.TestCase):
    """Each sabotage is red in enforce mode and reported in warn mode; the clean tree is green."""

    def run_guard(self, files, mode):
        _, root = scan_tree(files)
        policy = Path(tempfile.mkdtemp()) / "policy.json"
        policy.write_text(
            json.dumps({"images": [{"name": "ghost", "source": "docker.io/library/ghost", "digest": "sha256:" + "a" * 64}]})
        )
        out = io.StringIO()
        with redirect_stdout(out):
            code = guard.main(["--root", str(root), "--list", str(policy), "--mode", mode])
        return code, out.getvalue()

    SABOTAGE = {
        "re-added FROM ghost": {"Dockerfile": "FROM ghost:6.55.0-alpine\n"},
        "tag-only mirror ref": {"Dockerfile": "FROM ${IMAGE_REGISTRY:-docker.io/library}/ghost:6.55.0-alpine\n"},
        "hard-coded mirror ref": {"Dockerfile": f"FROM {HARD_CODED}\n"},
        "mirror override without packages: read": {
            ".github/workflows/ci.yml": "jobs:\n  t:\n    env:\n      IMAGE_REGISTRY: ghcr.io/branchleft/mirror\n"
        },
        "override to the public registry": {
            ".github/workflows/ci.yml": "permissions:\n  packages: read\njobs:\n  t:\n    env:\n      IMAGE_REGISTRY: docker.io/library\n"
        },
        "unqualified workflow service image": {
            ".github/workflows/ci.yml": "jobs:\n  t:\n    services:\n      db:\n        image: postgres:17-alpine\n"
        },
    }

    def test_enforce_is_red_for_each_sabotage(self):
        for label, files in self.SABOTAGE.items():
            code, out = self.run_guard(files, "enforce")
            self.assertEqual(code, 1, label)
            self.assertIn("1 reference(s) not on the mirror, 0 UNRESOLVED (mode enforce)", out, label)

    def test_warn_reports_the_same_findings_and_exits_zero(self):
        for label, files in self.SABOTAGE.items():
            code, out = self.run_guard(files, "warn")
            self.assertEqual(code, 0, label)
            self.assertIn("1 reference(s) not on the mirror, 0 UNRESOLVED (mode warn)", out, label)

    def test_enforce_is_green_on_a_clean_tree(self):
        files = {
            "Dockerfile": f"ARG IMAGE_REGISTRY\nFROM {MIRROR_OK}\n",
            ".github/workflows/ci.yml": "permissions:\n  packages: read\njobs:\n  t:\n    env:\n      IMAGE_REGISTRY: ghcr.io/branchleft/mirror\n    steps:\n      - run: docker build -t app:ci .\n",
        }
        code, out = self.run_guard(files, "enforce")
        self.assertEqual(code, 0)
        self.assertIn("0 reference(s) not on the mirror, 0 UNRESOLVED", out)

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
    """The list and the guard agree, using recorded references, not the live tree.

    A reference added anywhere in the tree must not turn this red: the whole-tree
    scan is the warn-mode job, and it reports without failing.
    """

    @staticmethod
    def written(entry):
        """The reference as a call site writes it (name, tag and digest)."""
        source = entry["source"]
        short = source.removeprefix("docker.io/library/").removeprefix("docker.io/")
        tag = entry["upstreamTags"][0]
        tagged = "" if tag == "pinned-digest-only" else f":{tag}"
        return f"{short}{tagged}@{entry['digest']}"

    def test_every_list_row_is_reported_as_a_third_party_reference(self):
        mirror_pairs, _ = guard.load_policy(LIST)
        _, images = mirror.load_list(LIST)
        files = {f"d{n}/Dockerfile": f"FROM {self.written(e)}\n" for n, e in enumerate(images)}
        findings, _root = scan_tree(files)
        self.assertEqual(len(findings), len(images))
        for f in findings:
            self.assertIn(f.kind, ("unqualified", "docker.io", "other-registry"), f.render())

    def test_every_list_row_can_be_written_in_the_form_the_guard_accepts(self):
        mirror_pairs, _ = guard.load_policy(LIST)
        _, images = mirror.load_list(LIST)
        for e in images:
            namespace, name = e["source"].rsplit("/", 1)
            tag = e["upstreamTags"][0]
            if tag == "pinned-digest-only":
                tag = "pinned"  # a digest with no tag is flagged: the call site must pick one
            ref = f"${{IMAGE_REGISTRY:-{namespace}}}/{name}:{tag}@{e['digest']}"
            self.assertIsNone(guard.classify(ref, mirror_pairs), ref)

    def test_the_whole_tree_scan_reports_and_exits_zero_in_warn_mode(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = guard.main(["--mode", "warn"])
        self.assertEqual(code, 0)
        self.assertIn("(mode warn)", out.getvalue())


def found(files, allow=()):
    """(path, line, kind) for each finding in a throwaway tree."""
    findings, _ = scan_tree(files, allow)
    return [(f.path, f.line, f.kind) for f in findings]


GOOD_FROM = "${IMAGE_REGISTRY:-docker.io/library}/ghost:6@sha256:" + "a" * 64
WORKFLOW = ".github/workflows/w.yml"


class DockerfileConstructTests(unittest.TestCase):
    """Each construct below was accepted by the first guard; each is a finding now."""

    def test_an_image_held_in_an_arg_default_is_followed_into_from(self):
        self.assertEqual(found({"Dockerfile": "ARG BASE=node:20\nFROM ${BASE}\n"}), [("Dockerfile", 2, "unqualified")])
        self.assertEqual(found({"Dockerfile": "ARG BASE=node:20\nFROM $BASE\n"}), [("Dockerfile", 2, "unqualified")])

    def test_an_arg_that_names_an_image_is_reported_where_it_is_defined(self):
        self.assertEqual(
            found({"Dockerfile": "ARG BASE_IMAGE=node:20\nFROM ${BASE_IMAGE}\n"}), [("Dockerfile", 1, "unqualified")]
        )

    def test_a_tag_held_in_an_arg_is_followed_into_from(self):
        self.assertEqual(found({"Dockerfile": "ARG V=20\nFROM node:${V}-alpine\n"}), [("Dockerfile", 2, "unqualified")])

    def test_a_registry_held_in_an_arg_is_followed_into_from(self):
        text = "ARG REG=evil.example\nFROM ${REG}/x@sha256:" + "a" * 64 + "\n"
        self.assertEqual(found({"Dockerfile": text}), [("Dockerfile", 2, "other-registry")])

    def test_an_arg_with_no_value_in_the_repo_is_unresolved_not_accepted(self):
        self.assertEqual(found({"Dockerfile": "ARG BASE\nFROM ${BASE}\n"}), [("Dockerfile", 2, "unresolved")])

    def test_from_across_a_line_continuation(self):
        self.assertEqual(found({"Dockerfile": "FROM \\\n  node:20\n"}), [("Dockerfile", 1, "unqualified")])
        self.assertEqual(
            found({"Dockerfile": "FROM --platform=linux/amd64 \\\n  node:20 AS x\n"}), [("Dockerfile", 1, "unqualified")]
        )

    def test_copy_from_an_image(self):
        text = "FROM scratch\nCOPY --from=node:20 /usr/local/bin/node /node\n"
        self.assertEqual(found({"Dockerfile": text}), [("Dockerfile", 2, "unqualified")])

    def test_run_mount_from_an_image(self):
        text = "FROM scratch\nRUN --mount=type=bind,from=postgres:17,target=/x true\n"
        self.assertEqual(found({"Dockerfile": text}), [("Dockerfile", 2, "unqualified")])

    def test_onbuild_copy_from_an_image_is_read(self):
        text = "FROM scratch\nONBUILD COPY --from=node:20 /a /b\n"
        self.assertEqual(found({"Dockerfile": text}), [("Dockerfile", 2, "unqualified")])

    def test_copy_from_a_stage_or_an_index_is_not_an_image(self):
        text = f"FROM {GOOD_FROM} AS build\nFROM scratch\nCOPY --from=build /a /b\nCOPY --from=0 /c /d\n"
        self.assertEqual(found({"Dockerfile": text}), [])

    def test_a_stage_name_shadows_an_image_name(self):
        self.assertEqual(found({"Dockerfile": "FROM scratch AS node\nFROM node\n"}), [])

    def test_a_stage_called_by_an_arg_is_not_an_image(self):
        self.assertEqual(found({"Dockerfile": "ARG T=app\nFROM scratch AS app\nFROM ${T}\n"}), [])

    def test_dockerfile_names(self):
        for name in ("dockerfile", "Containerfile", "ci/app.Dockerfile", "Dockerfile.dev"):
            self.assertEqual(found({name: "FROM node:20\n"}), [(name, 1, "unqualified")], name)


class RegistryHostTests(unittest.TestCase):
    def test_a_dotted_quad_registry_in_from(self):
        self.assertEqual(
            found({"Dockerfile": "FROM 203.0.113.9:5000/evil/img:1\n"}), [("Dockerfile", 1, "other-registry")]
        )

    def test_a_dotted_quad_registry_in_compose(self):
        text = "services:\n  a:\n    image: 203.0.113.9/evil/img:latest\n"
        self.assertEqual(found({"compose.yml": text}), [("compose.yml", 3, "other-registry")])

    def test_a_dotted_quad_registry_in_docker_run(self):
        self.assertEqual(
            found({"t.sh": "docker run --rm 203.0.113.9:5000/evil/img:1\n"}), [("t.sh", 1, "other-registry")]
        )

    def test_a_port_mapping_is_not_an_image(self):
        text = "docker run -d -p 127.0.0.1:3001:2368 --rm " + GOOD_FROM + "\n"
        self.assertEqual(found({"t.sh": text}), [])


class LocalBuildTests(unittest.TestCase):
    def test_a_build_name_with_a_registry_host_is_not_exempt(self):
        text = "docker build -t quay.io/evil/x .\ndocker run --rm quay.io/evil/x\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 2, "other-registry")])

    def test_an_unbuilt_ci_or_proof_tag_is_not_exempt(self):
        self.assertEqual(found({"Dockerfile": "FROM postgres:ci\n"}), [("Dockerfile", 1, "unqualified")])
        self.assertEqual(found({"Dockerfile": "FROM postgres:proof\n"}), [("Dockerfile", 1, "unqualified")])

    def test_a_build_exempts_only_the_name_and_tag_it_built(self):
        text = "docker build -t postgres .\ndocker run postgres:17\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 2, "unqualified")])
        text = "docker build -t app:ci .\ndocker run --rm app:ci\n"
        self.assertEqual(found({"t.sh": text}), [])

    def test_a_build_named_by_a_variable_exempts_that_name(self):
        text = 'IMG="app:local"\ndocker build -t "$IMG" .\ndocker run --rm "$IMG"\n'
        self.assertEqual(found({"t.sh": text}), [])


class KeyTests(unittest.TestCase):
    def test_a_yaml_image_env_key(self):
        text = "jobs:\n  t:\n    env:\n      IMAGE: postgres:17\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 4, "unqualified")])

    def test_a_yaml_star_image_env_key(self):
        text = "jobs:\n  t:\n    env:\n      DB_IMAGE: postgres:17\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 4, "unqualified")])

    def test_a_star_tag_key_in_shell_and_yaml(self):
        self.assertEqual(found({"t.sh": 'BLUE_TAG="ghost:6.55.0-alpine"\n'}), [("t.sh", 1, "unqualified")])
        self.assertEqual(found({"v.yml": "GREEN_TAG: ghost:6-alpine\n"}), [("v.yml", 1, "unqualified")])

    def test_a_bare_tag_in_a_star_tag_key_is_not_a_reference(self):
        self.assertEqual(found({"t.sh": 'IMAGE_TAG="v1.2.3"\nBLUE_TAG=6\nBASE_TAG=alpine\n'}), [])

    def test_an_env_key_then_docker_run_is_reported_once_at_the_definition(self):
        text = "jobs:\n  t:\n    steps:\n      - env:\n          IMAGE: postgres:17\n        run: docker run \"$IMAGE\"\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 5, "unqualified")])

    def test_a_yaml_anchor_on_a_scalar_and_its_alias(self):
        text = "x-img: &img postgres:17\nservices:\n  a:\n    image: *img\n"
        self.assertEqual(found({"compose.yml": text}), [("compose.yml", 1, "unqualified")])

    def test_a_yaml_anchor_on_an_image_key(self):
        text = "services:\n  a:\n    image: &i postgres:17\n"
        self.assertEqual(found({"compose.yml": text}), [("compose.yml", 3, "unqualified")])

    def test_an_alias_whose_anchor_is_elsewhere_is_unresolved(self):
        text = "services:\n  a:\n    image: *img\n"
        self.assertEqual(found({"compose.yml": text}), [("compose.yml", 3, "unresolved")])

    def test_yaml_flow_style(self):
        self.assertEqual(
            found({"compose.yml": "services: {a: {image: postgres:17}}\n"}), [("compose.yml", 1, "unqualified")]
        )

    def test_a_yaml_scalar_on_the_next_line(self):
        text = "services:\n  a:\n    image:\n      postgres:17\n"
        self.assertEqual(found({"compose.yml": text}), [("compose.yml", 4, "unqualified")])

    def test_quoted_and_spaced_yaml_keys_and_tags(self):
        for line in ('"image": postgres:17', "image : postgres:17", "image: !!str postgres:17"):
            self.assertEqual(found({"c.yml": f"services:\n  a:\n    {line}\n"}), [("c.yml", 3, "unqualified")], line)

    def test_interpolation_defaults_are_followed(self):
        for ref, kind in (
            ("${DB:-postgres:17}", "unqualified"),
            ("${IMAGE:-evil.example/x:1}", "other-registry"),
            ("${REGISTRY:-evil.example}/x@sha256:" + "a" * 64, "other-registry"),
        ):
            text = f"services:\n  a:\n    image: {ref}\n"
            self.assertEqual(found({"compose.yml": text}), [("compose.yml", 3, kind)], ref)

    def test_a_registry_variable_with_no_value_is_unresolved(self):
        text = "services:\n  a:\n    image: ${REGISTRY}/x:1\n"
        self.assertEqual(found({"compose.yml": text}), [("compose.yml", 3, "unresolved")])

    def test_a_docker_uri_in_uses(self):
        text = "jobs:\n  t:\n    steps:\n      - uses: docker://alpine:3.19\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 4, "unqualified")])

    def test_build_arg_values_that_are_images(self):
        text = "docker build --build-arg BASE=node:20 --build-arg VERSION=1.2.3 .\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")])

    def test_image_keys_in_toml_and_env_files(self):
        self.assertEqual(found({"ci.toml": 'image = "mysql:8.0"\n'}), [("ci.toml", 1, "unqualified")])
        self.assertEqual(found({".env": "DB_IMAGE=mysql:8.0\n"}), [(".env", 1, "unqualified")])

    def test_a_repository_name_the_file_completes_is_not_a_tag_less_pull(self):
        text = "env:\n  IMAGE: ghcr.io/branchleft/x\nrun: docker pull \"$IMAGE@$digest\"\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 3, "unresolved")])

    def test_a_value_written_to_github_output_is_not_a_reference(self):
        text = 'jobs:\n  t:\n    steps:\n      - run: echo "image=$IMAGE@$digest" >> "$GITHUB_OUTPUT"\n'
        self.assertEqual(found({WORKFLOW: text}), [])

    def test_a_default_on_its_own_variable_is_reported_once_at_the_definition(self):
        text = 'SRC_IMAGE="${SRC_IMAGE:-mysql:8.0@sha256:' + "a" * 64 + '}"\ndocker run --rm "$SRC_IMAGE"\n'
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")])

    def test_an_unresolved_definition_is_reported_once_not_again_at_each_use(self):
        text = 'IMAGE="${1:?usage}"\ndocker run --rm "$IMAGE"\n'
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unresolved")])

    def test_a_hetzner_image_name_is_not_a_container_image(self):
        self.assertEqual(found({"Pulumi.production.yaml": "config:\n  p:image: debian-13\n"}), [])


class CommandTests(unittest.TestCase):
    def test_podman_run(self):
        self.assertEqual(found({"t.sh": "podman run --rm alpine:3.19 true\n"}), [("t.sh", 1, "unqualified")])

    def test_container_run_and_global_flags_before_the_verb(self):
        self.assertEqual(found({"t.sh": "docker container run --rm alpine:3.19 true\n"}), [("t.sh", 1, "unqualified")])
        self.assertEqual(found({"t.sh": "docker --host unix:///x run --rm alpine:3.19\n"}), [("t.sh", 1, "unqualified")])

    def test_a_runtime_held_in_a_variable(self):
        self.assertEqual(found({"t.sh": "$DOCKER run --rm alpine:3.19 true\n"}), [("t.sh", 1, "unqualified")])
        self.assertEqual(found({"t.sh": "sudo ${DOCKER} run --rm alpine:3.19\n"}), [("t.sh", 1, "unqualified")])

    def test_an_image_held_in_a_variable_is_followed_into_docker_run(self):
        text = 'IMG=alpine:3.19\ndocker run --rm "$IMG" true\n'
        self.assertEqual(found({"t.sh": text}), [("t.sh", 2, "unqualified")])
        text = 'image=alpine:3.19\ndocker run --rm "$image" true\n'
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")])

    def test_a_variable_with_no_value_in_the_repo_is_unresolved(self):
        self.assertEqual(found({"t.sh": 'docker run --rm "$VAR" cmd\n'}), [("t.sh", 1, "unresolved")])

    def test_a_value_flag_with_a_number_does_not_hide_the_image(self):
        text = "docker run --rm --future-limit 512 mysql:8.0 true\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")])
        text = "docker run --rm --cpu-shares 512 mysql:8.0 true\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")])

    def test_a_stop_signal_is_not_the_image(self):
        text = f"docker run --rm --stop-signal SIGKILL {GOOD_FROM} true\n"
        self.assertEqual(found({"t.sh": text}), [])

    def test_a_workflow_step_name_mentioning_docker_run_is_not_a_command(self):
        text = "jobs:\n  t:\n    steps:\n      - name: Check docker run works offline\n        run: true\n"
        self.assertEqual(found({WORKFLOW: text}), [])

    def test_a_trailing_comment_mentioning_docker_run_is_not_a_command(self):
        self.assertEqual(found({"t.sh": "true # then docker run something\n"}), [])

    def test_a_message_mentioning_docker_pull_is_not_a_command(self):
        self.assertEqual(found({"t.sh": 'echo "docker pull failed; is the daemon up" >&2\n'}), [])

    def test_a_quoted_command_in_a_shell_string_is_read(self):
        self.assertEqual(found({"t.sh": "ssh host 'docker run --rm alpine:3.19 true'\n"}), [("t.sh", 1, "unqualified")])

    def test_an_unclosed_quote_after_the_image_keeps_the_image(self):
        text = "docker run --rm -v \"$PWD\":/repo:ro -w /repo debian:bookworm-slim bash -c '\n  true\n'\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")])

    def test_a_variable_of_options_is_not_the_image(self):
        text = "eval docker run $args widgets-proof:local\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")])


class CodeConstructTests(unittest.TestCase):
    def test_a_command_string(self):
        text = "execSync('docker run --rm postgres:17 psql');\n"
        self.assertEqual(found({"x.ts": text}), [("x.ts", 1, "unqualified")])

    def test_a_quoted_docker_run_phrase_with_no_image_is_not_a_finding(self):
        self.assertEqual(found({"t.py": 'self.assertNotIn("docker run", text)\n'}), [])
        self.assertEqual(found({"u.py": 'names = ["docker run", "alpine"]\n'}), [])

    def test_a_quoted_command_ends_at_its_closing_quote(self):
        findings, _ = scan_tree({"x.py": 'cmd = ["docker run alpine:3.19", "--flag"]\n'})
        self.assertEqual([f.ref for f in findings], ["alpine:3.19"])

    def test_lts_and_alpine_tags(self):
        self.assertEqual(found({"x.ts": "const image = 'node:lts-alpine';\n"}), [("x.ts", 1, "unqualified")])
        self.assertEqual(found({"x.ts": "const a = 'postgres:alpine'; // docker\n"}), [("x.ts", 1, "unqualified")])

    def test_a_bare_name_assigned_to_an_image_key(self):
        self.assertEqual(found({"x.ts": "const image = 'alpine';\n"}), [("x.ts", 1, "unqualified")])

    def test_a_template_literal_with_a_variable_tag_is_unresolved(self):
        text = "const image = `node:${V}`;\n"
        self.assertEqual(found({"x.ts": text}), [("x.ts", 1, "unresolved")])

    def test_a_registry_qualified_name_with_no_tag(self):
        text = "const image = 'quay.io/evil/x';\n"
        self.assertEqual(found({"x.ts": text}), [("x.ts", 1, "other-registry")])
        self.assertEqual(found({"y.ts": "pull('quay.io/evil/x'); // docker\n"}), [("y.ts", 1, "other-registry")])

    def test_a_well_known_image_far_from_any_docker_word(self):
        self.assertEqual(found({"x.ts": "\n" * 20 + "const X = 'mysql:8.0';\n"}), [("x.ts", 21, "unqualified")])
        self.assertEqual(found({"x.py": "\n" * 20 + "X = 'mysql:8.0'\n"}), [("x.py", 21, "unqualified")])

    def test_a_two_part_registry_path_in_prose_is_not_an_image(self):
        text = '"""`ghcr.io/branchleft` without the slash also matches an image name."""\n'
        self.assertEqual(found({"x.py": text}), [])

    def test_a_build_given_as_an_argument_array_exempts_its_tag(self):
        text = "const TEST_IMAGE = 'app-test:local';\nexecFileSync('docker', ['build', '-t', TEST_IMAGE, '.']);\n"
        self.assertEqual(found({"x.ts": text}), [])
        self.assertEqual(found({"x.ts": "const TEST_IMAGE = 'app-test:local';\n"}), [("x.ts", 1, "unqualified")])

    def test_a_placeholder_in_angle_brackets_is_not_an_image(self):
        text = '"""`docker run --rm <image> <binary> --version`."""\n'
        self.assertEqual(found({"x.py": text}), [])

    def test_a_port_is_not_a_tag(self):
        self.assertEqual(found({"x.ts": "const host = 'mysql:3306'; // docker\n"}), [])

    def test_a_port_mapping_template_is_not_an_image(self):
        self.assertEqual(found({"x.ts": "const p = `127.0.0.1:${port}:2368`; // docker\n"}), [])

    def test_a_container_name_is_not_an_image(self):
        self.assertEqual(found({"x.mjs": "const spec = { container: 'c1' };\n"}), [])
        self.assertEqual(found({"x.mjs": "const spec = { container: 'mysql' };\n"}), [])

    def test_a_container_variable_in_a_script_is_a_name_not_an_image(self):
        self.assertEqual(found({"t.sh": 'container="mysql"\ndocker rm -f "$container"\n'}), [])

    def test_python_subprocess_list_arguments(self):
        text = "import subprocess\nsubprocess.run(['docker', 'run', '--rm', 'mysql:8.0'])\n"
        self.assertEqual(found({"x.py": text}), [("x.py", 2, "unqualified")])


class FileTypeTests(unittest.TestCase):
    def test_these_files_are_scanned(self):
        cases = {
            "x.cjs": "run('mysql:8.0'); // docker\n",
            "x.tsx": "run('mysql:8.0'); // docker\n",
            "x.mts": "run('mysql:8.0'); // docker\n",
            "ci.toml": 'image = "mysql:8.0"\n',
            ".env": "DB_IMAGE=mysql:8.0\n",
            "Makefile": "t:\n\tdocker run --rm mysql:8.0\n",
            "t.bash": "docker run --rm mysql:8.0\n",
            "bin2/run": "#!/bin/sh\ndocker run --rm mysql:8.0\n",
            "bin/t.sh": "docker run --rm mysql:8.0\n",
            "scripts/bin/t.sh": "docker run --rm mysql:8.0\n",
        }
        for name, text in cases.items():
            self.assertEqual([k for _, _, k in found({name: text})], ["unqualified"], name)

    def test_vendored_output_and_forks_are_skipped_by_design(self):
        for name in ("widgets/dist/x.min.js", "forks/x/compose.yml", "node_modules/x/Dockerfile"):
            self.assertEqual(found({name: "FROM mysql:8.0\nimage: mysql:8.0\n"}), [], name)


class OverrideTests(unittest.TestCase):
    MIRROR = "ghcr.io/branchleft/mirror"

    def test_a_comment_does_not_grant_packages_read(self):
        text = f"# packages: read\nenv:\n  IMAGE_REGISTRY: {self.MIRROR}\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 3, "override-no-permission")])

    def test_packages_none_does_not_grant_it(self):
        text = f"permissions:\n  packages: none\nenv:\n  IMAGE_REGISTRY: {self.MIRROR}\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 4, "override-no-permission")])

    def test_packages_write_in_another_job_does_not_grant_it(self):
        text = (
            "jobs:\n  a:\n    permissions:\n      packages: write\n  b:\n    permissions:\n      contents: read\n"
            f"    env:\n      IMAGE_REGISTRY: {self.MIRROR}\n"
        )
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 9, "override-no-permission")])

    def test_a_job_that_grants_it_is_clean_and_a_workflow_level_grant_covers_its_jobs(self):
        job = f"jobs:\n  a:\n    permissions:\n      packages: read\n    env:\n      IMAGE_REGISTRY: {self.MIRROR}\n"
        self.assertEqual(found({WORKFLOW: job}), [])
        top = f"permissions:\n  packages: read\njobs:\n  a:\n    env:\n      IMAGE_REGISTRY: {self.MIRROR}\n"
        self.assertEqual(found({WORKFLOW: top}), [])

    def test_an_override_through_build_arg_export_and_github_env(self):
        head = "permissions:\n  packages: read\njobs:\n  t:\n    steps:\n"
        for line in (
            "      - run: docker build --build-arg IMAGE_REGISTRY=evil.example .",
            "      - run: export IMAGE_REGISTRY=evil.example",
            '      - run: echo "IMAGE_REGISTRY=evil.example" >> $GITHUB_ENV',
        ):
            self.assertEqual(found({WORKFLOW: head + line + "\n"}), [(WORKFLOW, 6, "bad-override")], line)

    def test_an_override_through_build_arg_to_the_mirror_needs_the_permission(self):
        text = f"jobs:\n  t:\n    steps:\n      - run: docker build --build-arg IMAGE_REGISTRY={self.MIRROR} .\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 4, "override-no-permission")])

    def test_an_expression_override_is_unresolved(self):
        text = "permissions:\n  packages: read\nenv:\n  IMAGE_REGISTRY: ${{ vars.REG }}\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 4, "unresolved")])

    def test_a_default_expression_is_not_an_override(self):
        text = 'jobs:\n  t:\n    steps:\n      - run: echo "${IMAGE_REGISTRY:-docker.io/library}"\n'
        self.assertEqual(found({WORKFLOW: text}), [])


class DigestOnlyTests(unittest.TestCase):
    def test_a_digest_with_no_tag_is_flagged_on_the_mirror_form_and_on_our_own_images(self):
        mirror_form = "services:\n  a:\n    image: ${IMAGE_REGISTRY:-docker.io/library}/ghost@sha256:" + "a" * 64 + "\n"
        self.assertEqual(found({"c.yml": mirror_form}), [("c.yml", 3, "no-tag")])
        own = "services:\n  a:\n    image: ghcr.io/branchleft/anything@sha256:" + "a" * 64 + "\n"
        self.assertEqual(found({"c.yml": own}), [("c.yml", 3, "no-tag")])

    def test_a_tag_and_a_digest_is_clean(self):
        text = "services:\n  a:\n    image: " + GOOD_FROM + "\n"
        self.assertEqual(found({"c.yml": text}), [])


class SourceTests(unittest.TestCase):
    def test_the_mirror_script_parses_on_python_3_11(self):
        """A f-string that reuses its own quote is valid from 3.12 only; CI is 3.12, a laptop may not be."""
        source = (HERE / "mirror-images.py").read_text()
        try:
            ast.parse(source)
        except SyntaxError as err:
            self.fail(f"mirror-images.py does not parse on {sys.version.split()[0]}: {err}")
        if sys.version_info < (3, 12):
            return  # the parse above is the check: 3.11 rejects the construct outright
        stack = []
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.FSTRING_START:
                if stack and tok.string.lstrip("fFrR")[:1] == stack[-1]:
                    self.fail(f"line {tok.start[0]}: f-string nested in an f-string with the same quote")
                stack.append(tok.string.lstrip("fFrR")[:1])
            elif tok.type == tokenize.FSTRING_END:
                stack.pop()
            elif tok.type == tokenize.STRING and stack and tok.string.lstrip("bBrRuU")[:1] == stack[-1]:
                self.fail(f"line {tok.start[0]}: string inside an f-string uses the f-string's own quote")


PORTAL_STEP = (
    "jobs:\n  t:\n    steps:\n      - name: Start\n        env:\n"
    "          IMAGE: postgres:17@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f\n"
    "        run: |\n          docker run -d --rm --name x -p 5432:5432 \\\n            -e POSTGRES_PASSWORD=x \\\n"
    '            "$IMAGE" -c hba_file=/x\n'
)
DRIFT_SCRIPT = '#!/bin/sh\nset -e\nBLUE_TAG="ghost:6.55.0-alpine"\nGREEN_TAG="ghost:6-alpine"\n'


class RecordedPullTests(unittest.TestCase):
    """The pulls the first inventory missed, as recorded fixtures of their call sites."""

    def test_the_postgres_run_by_variable_in_a_workflow_step(self):
        self.assertEqual(found({WORKFLOW: PORTAL_STEP}), [(WORKFLOW, 6, "unqualified")])

    def test_the_two_ghost_tags_in_a_script(self):
        self.assertEqual(
            found({"scripts/measure.sh": DRIFT_SCRIPT}),
            [("scripts/measure.sh", 3, "unqualified"), ("scripts/measure.sh", 4, "unqualified")],
        )

    def test_the_missed_pulls_have_a_row_on_the_list(self):
        _, images = mirror.load_list(LIST)
        rows = {(e["source"], e["digest"]) for e in images}
        self.assertIn(("docker.io/library/postgres", "sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f"), rows)
        tags = {(e["source"], t) for e in images for t in e["upstreamTags"]}
        self.assertIn(("docker.io/library/ghost", "6.55.0-alpine"), tags)
        self.assertIn(("docker.io/library/ghost", "6-alpine"), tags)

    def test_the_dockerfile_frontend_has_a_row_on_the_list(self):
        _, images = mirror.load_list(LIST)
        self.assertIn(("docker.io/docker/dockerfile", "1"), {(e["source"], t) for e in images for t in e["upstreamTags"]})

    def test_unresolved_references_are_reported_and_fail_enforce(self):
        _, root = scan_tree({"t.sh": 'docker run "$X"\n'})
        policy = Path(tempfile.mkdtemp()) / "p.json"
        policy.write_text(json.dumps({"images": []}))
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(guard.main(["--root", str(root), "--list", str(policy), "--mode", "enforce"]), 1)
            self.assertEqual(guard.main(["--root", str(root), "--list", str(policy), "--mode", "warn"]), 0)
        self.assertIn("UNRESOLVED reference", out.getvalue())


class BuildKitConstructTests(unittest.TestCase):
    """Constructs found in review of the second guard; each was silent."""

    def test_a_syntax_directive_names_the_frontend_image_it_pulls(self):
        text = "# syntax=docker/dockerfile:1\nFROM scratch\n"
        self.assertEqual(found({"Dockerfile": text}), [("Dockerfile", 1, "docker.io")])

    def test_a_syntax_directive_after_a_comment_is_only_a_comment(self):
        text = "# build notes\n# syntax=docker/dockerfile:1\nFROM scratch\n"
        self.assertEqual(found({"Dockerfile": text}), [])

    def test_a_syntax_directive_with_a_spaced_equals_and_other_directives_before_it(self):
        text = "# escape=`\n# syntax = docker/dockerfile:1.7\nFROM scratch\n"
        self.assertEqual(found({"Dockerfile": text}), [("Dockerfile", 2, "docker.io")])

    def test_a_dockerfile_with_a_byte_order_mark_is_read(self):
        text = "\ufeffFROM node:20\n"
        self.assertEqual(found({"Dockerfile": text}), [("Dockerfile", 1, "unqualified")])
        text = "\ufeff# syntax=docker/dockerfile:1\nFROM scratch\n"
        self.assertEqual(found({"Dockerfile": text}), [("Dockerfile", 1, "docker.io")])

    def test_a_build_context_that_is_an_image(self):
        text = "docker buildx build --build-context base=docker-image://alpine:3 .\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")])
        text = "with:\n  build-contexts: |\n    base=docker-image://alpine:3\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 3, "unqualified")])

    def test_a_registry_cache_source(self):
        text = "docker buildx build --cache-from type=registry,ref=quay.io/evil/cache:1 .\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "other-registry")])
        text = "docker buildx build --cache-from quay.io/evil/cache:1 .\n"
        self.assertEqual(found({"u.sh": text}), [("u.sh", 1, "other-registry")])
        self.assertEqual(found({"v.sh": "docker buildx build --cache-from type=gha .\n"}), [])

    def test_an_image_key_with_a_docker_uri(self):
        text = "runs:\n  using: docker\n  image: docker://alpine:3\n"
        self.assertEqual(found({"action.yml": text}), [("action.yml", 3, "unqualified")])


class CommandPositionTests(unittest.TestCase):
    """Forms in which docker is the command but not the first word."""

    def test_these_prefixes_are_read(self):
        prefixes = (
            "FOO=1 docker run --rm alpine:3 true",
            "env FOO=1 docker run --rm alpine:3 true",
            "timeout 60 docker run --rm alpine:3 true",
            "retry 3 docker run --rm alpine:3 true",
            "until docker run --rm alpine:3 true; do sleep 1; done",
            "if false; then :; elif docker run --rm alpine:3 true; then :; fi",
            "/usr/bin/docker run --rm alpine:3 true",
            "$(DOCKER) run --rm alpine:3 true",
        )
        for line in prefixes:
            self.assertEqual(found({"t.sh": line + "\n"}), [("t.sh", 1, "unqualified")], line)

    def test_a_systemd_exec_line(self):
        text = "[Service]\nExecStart=/usr/bin/docker run --rm alpine:3 true\n"
        self.assertEqual(found({"x.service": text}), [("x.service", 2, "unqualified")])

    def test_prose_before_docker_is_still_not_a_command(self):
        for line in ("echo see docker run alpine:3", "# docker run alpine:3", "the docker run alpine:3 example"):
            self.assertEqual(found({"t.sh": line + "\n"}), [], line)


class UnknownFlagTests(unittest.TestCase):
    """A flag the list does not know may hide the image: the guard fails closed."""

    def test_a_key_value_flag_value_is_unresolved_not_accepted(self):
        text = "docker run --rm --ulimit nofile=1024:2048 alpine:3 true\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unresolved")])

    def test_a_path_flag_value_is_unresolved_not_accepted(self):
        text = "docker run --rm --device-read-bps /dev/sda:1mb alpine:3 true\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unresolved")])

    def test_a_known_flag_with_the_same_value_shape_is_read(self):
        text = "docker run --rm --sysctl net.core.somaxconn=1024 alpine:3 true\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")])

    def test_prose_after_docker_run_is_not_an_operand(self):
        self.assertEqual(found({"x.ts": "execSync('docker run failed: see the logs');\n"}), [])


class MakefileAndRunKeyTests(unittest.TestCase):
    """Forms the docs claim, found in review of the third guard: each was silently accepted."""

    def test_an_assignment_between_a_yaml_run_key_and_docker(self):
        for line in (
            "- run: FOO=1 docker run --rm alpine:3 true",
            "- run: FOO=1 BAR=2 docker run --rm alpine:3 true",
            "- run: DOCKER_BUILDKIT=1 docker pull alpine:3",
        ):
            text = "jobs:\n  t:\n    steps:\n      " + line + "\n"
            self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 4, "unqualified")], line)

    def test_an_assignment_after_a_yaml_command_key(self):
        text = "services:\n  a:\n    command: FOO=1 docker run --rm alpine:3 true\n"
        self.assertEqual(found({"c.yml": text}), [("c.yml", 3, "unqualified")])

    def test_a_quoted_assignment_before_docker(self):
        self.assertEqual(found({"t.sh": 'FOO="a b" docker run --rm alpine:3 true\n'}), [("t.sh", 1, "unqualified")])

    def test_makefile_assignment_operators(self):
        for line in ("IMAGE ?= node:20", "IMAGE := node:20", "IMAGE ::= node:20", "NODE_IMAGE ?= node:20", "export IMAGE := node:20"):
            self.assertEqual(found({"Makefile": line + "\n"}), [("Makefile", 1, "unqualified")], line)

    def test_a_makefile_variable_is_followed_into_a_recipe(self):
        text = "IMAGE := node:20\nt:\n\t@docker run --rm $(IMAGE) true\n"
        self.assertEqual(found({"Makefile": text}), [("Makefile", 1, "unqualified")])

    def test_a_makefile_variable_with_no_value_is_unresolved(self):
        self.assertEqual(found({"Makefile": "t:\n\tdocker run --rm $(IMG) true\n"}), [("Makefile", 2, "unresolved")])

    def test_a_makefile_recipe_prefix(self):
        for recipe in ("@docker run --rm node:20 true", "-docker run --rm node:20 true", "+docker run --rm node:20 true",
                       "@$(DOCKER) run --rm node:20 true", "@FOO=1 docker run --rm node:20 true"):
            self.assertEqual(found({"Makefile": "t:\n\t" + recipe + "\n"}), [("Makefile", 2, "unqualified")], recipe)

    def test_a_word_ending_in_docker_is_not_a_command(self):
        self.assertEqual(found({"t.sh": "my-docker run --rm node:20 true\n"}), [])

    def test_a_login_shell_string(self):
        for flag in ("-ec", "-lc"):
            self.assertEqual(
                found({"t.sh": f"bash {flag} 'docker run --rm node:20 true'\n"}), [("t.sh", 1, "unqualified")], flag
            )

    def test_a_case_arm(self):
        text = "case $1 in\n  a) docker run --rm node:20 true ;;\nesac\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 2, "unqualified")])

    def test_a_quoted_multi_word_flag_value_is_unresolved(self):
        text = "docker run --rm --device-cgroup-rule 'c 42:* rmw' alpine:3 true\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unresolved")])


class ArgumentSpellingTests(unittest.TestCase):
    """Spellings of the arguments before the image, and of a quoted command, found in review of the fourth guard."""

    def test_a_command_substitution_with_a_space_before_the_image(self):
        for argv in (
            "-u $(id -u):$(id -g)",
            "--name x-$(date +%s)",
            "-v $(realpath .):/w",
            "-e FOO=$(cat f)",
            "--user=$(id -u)",
            "-e N=$((1 + 2))",
            "-u `id -u`",
        ):
            text = f"docker run --rm {argv} alpine:3 id\n"
            self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")], argv)

    def test_a_backtick_value_is_one_word(self):
        findings, _ = scan_tree({"t.sh": "docker run --rm -u `echo node` alpine:3 id\n"})
        self.assertEqual([f.ref for f in findings], ["alpine:3"])

    def test_a_command_substitution_before_the_image_in_a_makefile_and_a_workflow(self):
        self.assertEqual(
            found({"Makefile": "t:\n\tdocker run --rm -u $(shell id -u) alpine:3 id\n"}), [("Makefile", 2, "unqualified")]
        )
        text = "jobs:\n  t:\n    steps:\n      - run: docker run --rm -u $(id -u):$(id -g) alpine:3 id\n"
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 4, "unqualified")])

    def test_a_command_substitution_that_is_the_image_is_unresolved(self):
        self.assertEqual(found({"t.sh": "docker run --rm $(cat image.txt) id\n"}), [("t.sh", 1, "unresolved")])

    def test_a_quoted_scalar_after_a_run_or_command_key(self):
        for line in (
            '- run: "docker run --rm alpine:3 id"',
            "- run: 'docker run --rm alpine:3 id'",
            '- run: "FOO=1 docker run --rm alpine:3 id"',
            '    command: "docker run --rm alpine:3 id"',
        ):
            self.assertEqual(found({"w.yml": line + "\n"}), [("w.yml", 1, "unqualified")], line)

    def test_a_quoted_name_that_mentions_docker_run_is_not_a_command(self):
        self.assertEqual(found({"w.yml": '- name: "docker run alpine:3"\n'}), [])

    def test_ssh_with_options_and_an_unquoted_remote_command(self):
        for line in (
            "ssh -o X=y host 'docker pull alpine:3'",
            "ssh -t host 'docker pull alpine:3'",
            "ssh -i key user@host \"docker pull alpine:3\"",
            "ssh user@host docker pull alpine:3",
            "ssh -t host docker pull alpine:3",
        ):
            self.assertEqual(found({"t.sh": line + "\n"}), [("t.sh", 1, "unqualified")], line)

    def test_a_case_arm_followed_by_an_assignment(self):
        text = "case $1 in\n  a) FOO=1 docker run --rm alpine:3 ;;\nesac\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 2, "unqualified")])

    def test_a_makefile_shell_function(self):
        text = "X := $(shell docker run --rm alpine:3 id)\n"
        self.assertEqual(found({"Makefile": text}), [("Makefile", 1, "unqualified")])

    def test_a_command_held_in_a_shell_string_variable(self):
        self.assertEqual(found({"t.sh": 'CMD="docker run --rm alpine:3 true"\n'}), [("t.sh", 1, "unqualified")])

    def test_an_assignment_inside_a_command_string_in_code(self):
        for path, text in (
            ("x.ts", "execSync('FOO=1 docker run --rm node:20 true');\n"),
            ("package.json", '{"scripts":{"t":"FOO=1 docker run --rm node:20 true"}}\n'),
            ("package.json", '{"scripts":{"t":"npm run b && docker run --rm node:20 true"}}\n'),
        ):
            self.assertEqual(found({path: text}), [(path, 1, "unqualified")], text)

    def test_a_plain_word_flag_value_with_punctuation_does_not_hide_the_image(self):
        for value in ("a,b", "a+b", "a@b", "a!b", "x,y:z"):
            text = f"docker run --rm --some-flag {value} alpine:3 true\n"
            self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unresolved")], value)

    def test_a_redirect_before_the_image(self):
        for redirect in ("2>/dev/null", ">/dev/null", "2>&1"):
            text = f"docker run --rm {redirect} alpine:3 true\n"
            self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unqualified")], redirect)

    def test_a_build_arg_value_with_a_variable_registry(self):
        text = "docker build --build-arg BASE=${REG}/node:20 .\n"
        self.assertEqual(found({"t.sh": text}), [("t.sh", 1, "unresolved")])
        self.assertEqual(found({"u.sh": "docker build --build-arg VERSION=$V .\n"}), [])

    def test_a_quoted_assignment_of_an_image_in_an_echo_to_the_environment_file(self):
        text = 'jobs:\n  t:\n    steps:\n      - run: echo "IMAGE=postgres:17" >> $GITHUB_ENV\n'
        self.assertEqual(found({WORKFLOW: text}), [(WORKFLOW, 4, "unqualified")])


class QuotedHostTemplateAndSingleQuoteTests(unittest.TestCase):
    """Spellings the cycle-3 tokeniser change stopped reading, found in the fifth review; each was reported before."""

    SSH_LINES = (
        "ssh \"$HOST\" 'docker pull alpine:3.19'",
        "ssh user@\"$HOST\" 'docker pull alpine:3.19'",
        'ssh "${HOST}" "docker run --rm alpine:3.19 id"',
        "ssh -i \"$KEY\" user@host 'docker pull alpine:3.19'",
        'ssh -o "StrictHostKeyChecking=no" host "docker pull alpine:3.19"',
        "ssh -p 22 \"$HOST\" 'docker pull alpine:3.19'",
    )
    TEMPLATE_LINES = (
        "execSync(`cd ${dir} && docker pull alpine:3.19`);",
        "run(`echo hi && docker pull alpine:3.19`);",
        "await sh(`set -e; docker pull alpine:3.19`);",
        "exec(`cd ${d} && docker pull alpine:3.19`).then(x);",
        "run(`docker pull alpine:3.19`, `a b`);",
        "run(`cd d && docker pull alpine:3.19`, `a b`);",
    )
    SINGLE_QUOTED = (
        "docker run --rm -e 'X=`' alpine:3.19 id",
        "docker run --rm --label 'a`b' alpine:3.19 id",
        "docker run --rm -e 'X=$(' alpine:3.19 id",
        "docker run --rm -e 'X=$(echo a b' alpine:3.19 id",
        "docker run --rm -e 'X=`' alpine:3.19 id && echo `date`",
    )

    def refs(self, path, line):
        findings, _ = scan_tree({path: line + "\n"})
        return [(f.kind, f.ref) for f in findings]

    def test_a_quoted_host_or_option_value_before_an_ssh_command_string(self):
        for line in self.SSH_LINES:
            self.assertEqual(self.refs("t.sh", line), [("unqualified", "alpine:3.19")], line)

    def test_ssh_agent_is_not_ssh(self):
        self.assertEqual(self.refs("t.sh", 'echo ssh-agent "docker run --rm alpine:3.19 id"'), [])

    def test_a_command_in_a_template_literal_whose_image_is_the_last_word(self):
        for line in self.TEMPLATE_LINES:
            self.assertEqual(self.refs("x.ts", line), [("unqualified", "alpine:3.19")], line)

    def test_a_template_literal_command_after_sudo_or_an_assignment(self):
        for line in ("exec(`sudo docker pull alpine:3.19`);", "exec(`FOO=1 docker pull alpine:3.19`);"):
            self.assertEqual(self.refs("x.ts", line), [("unqualified", "alpine:3.19")], line)

    def test_an_unbalanced_backtick_or_dollar_paren_inside_single_quotes(self):
        for line in self.SINGLE_QUOTED:
            self.assertEqual(self.refs("t.sh", line), [("unqualified", "alpine:3.19")], line)

    def test_an_unclosed_dollar_paren_outside_quotes_does_not_swallow_the_image(self):
        self.assertEqual(self.refs("t.sh", "docker run --rm -e X=$( alpine:3.19 id"), [("unqualified", "alpine:3.19")])

    def test_the_spellings_the_limits_sentence_says_it_also_reads(self):
        for path, text in (
            ("w.yml", "- script: docker run --rm alpine:3.19 id\n"),
            ("w.yml", "- cmd: docker run --rm alpine:3.19 id\n"),
            ("w.yml", "- entrypoint: docker run --rm alpine:3.19 id\n"),
            ("t.sh", "! docker run --rm alpine:3.19 id\n"),
            ("t.sh", "{ docker run --rm alpine:3.19 id; }\n"),
            ("t.sh", "docker container run --rm alpine:3.19 id\n"),
        ):
            kinds = [k for _, _, k in found({path: text})]
            self.assertEqual(kinds, ["unqualified"], text)

    def test_a_long_line_of_command_substitutions_is_scanned_in_linear_time(self):
        line = "docker run --rm " + "$(x y) " * 40000 + "alpine:3.19 id"
        start = time.monotonic()
        words = guard.tokens_of(line[len("docker"):])
        elapsed = time.monotonic() - start
        self.assertGreater(len(words), 40000)
        self.assertLess(elapsed, 3.0)

    def test_a_long_line_of_unclosed_substitutions_is_scanned_in_linear_time(self):
        line = "docker run --rm " + "$( x " * 8000 + "alpine:3.19 id"
        start = time.monotonic()
        words = guard.tokens_of(line[len("docker"):])
        elapsed = time.monotonic() - start
        self.assertGreater(len(words), 8000)
        self.assertLess(elapsed, 3.0)


def _lines(prefixes, tail="docker run --rm alpine:3 true"):
    return [("t.sh", f"{p} {tail}\n") for p in prefixes]


CLAIMS = {
    "dockerfile-from": [("Dockerfile", "FROM node:20\n")],
    "dockerfile-copy-from": [("Dockerfile", "FROM scratch\nCOPY --from=node:20 /a /b\n")],
    "dockerfile-run-mount": [("Dockerfile", "FROM scratch\nRUN --mount=type=bind,from=postgres:17,target=/x true\n")],
    "dockerfile-arg-env": [("Dockerfile", "ARG BASE=node:20\nFROM $BASE\n"), ("Dockerfile", "ENV B=node:20\nFROM $B\n")],
    "dockerfile-continuation": [("Dockerfile", "FROM \\\n  node:20\n")],
    "dockerfile-bom": [("Dockerfile", "\ufeffFROM node:20\n")],
    "dockerfile-syntax": [("Dockerfile", "# syntax=docker/dockerfile:1\nFROM scratch\n")],
    "yaml-image": [("c.yml", "services:\n  a:\n    image: postgres:17\n")],
    "yaml-container": [(WORKFLOW, "jobs:\n  t:\n    container: node:20\n")],
    "yaml-env-keys": [("c.yml", "IMAGE: postgres:17\n"), ("c.yml", "DB_IMAGE: postgres:17\n")],
    "yaml-tag-keys": [("c.yml", "BLUE_TAG: ghost:6\n")],
    "yaml-anchors": [("c.yml", "x: &i postgres:17\n")],
    "yaml-flow": [("c.yml", "s: {a: {image: postgres:17}}\n")],
    "yaml-docker-uri": [
        (WORKFLOW, "jobs:\n  t:\n    steps:\n      - uses: docker://alpine:3\n"),
        ("action.yml", "runs:\n  using: docker\n  image: docker://alpine:3\n"),
    ],
    "assign-image": [
        ("t.sh", "IMAGE=node:20\n"),
        (".env", "IMAGE=node:20\n"),
        ("ci.toml", 'image = "node:20"\n'),
        ("w.yml", '- run: echo "IMAGE=node:20" >> $GITHUB_ENV\n'),
    ],
    "assign-suffix": [("t.sh", "DB_IMAGE=node:20\n"), (".env", "DB_IMAGE=node:20\n")],
    "assign-tag": [("t.sh", "BLUE_TAG=ghost:6\n")],
    "make-assign": [("Makefile", f"IMAGE {op} node:20\n") for op in ("=", "?=", ":=", "::=", "+=")],
    "bare-name": [("c.yml", "image: foo:1\n"), ("c.yml", "image: nginx\n")],
    "docker-verbs": [("t.sh", f"docker {v} alpine:3\n") for v in ("run", "create", "pull")],
    "docker-runtimes": [("t.sh", f"{r} run alpine:3\n") for r in ("docker", "podman", "nerdctl")],
    "command-line-start": [("t.sh", "docker run alpine:3\n")],
    "command-separators": _lines((";", "true &&", "false ||", "true |", "(", "`", "$("), "docker run alpine:3 true"),
    "command-words": _lines(
        ("then", "do", "else", "elif", "if", "until", "while", "sudo", "exec", "time", "eval", "command", "nohup",
         "xargs", "env", "timeout 60", "retry 3", "nice", "ionice", "watch")
    ),
    "command-wrapper-options": _lines(("timeout 60", "retry 3", "nice -n 5", "FOO=1", 'FOO="a b"', "env FOO=1 BAR=2")),
    "command-yaml-keys": [
        ("w.yml", "- run: docker run alpine:3\n"),
        ("w.yml", "- run: FOO=1 docker run alpine:3\n"),
        ("w.yml", "- run: DOCKER_BUILDKIT=1 docker pull alpine:3\n"),
        ("w.yml", "    command: docker run alpine:3\n"),
        ("w.yml", "    command: FOO=1 docker run alpine:3\n"),
        ("w.yml", "      - run: |\n          docker run alpine:3\n"),
    ],
    "command-quoted": [
        ("t.sh", "sh -c 'docker run alpine:3'\n"),
        ("t.sh", 'bash -c "docker run alpine:3"\n'),
        ("t.sh", "bash -lc 'docker run alpine:3'\n"),
        ("t.sh", "sh -ec 'docker run alpine:3'\n"),
        ("t.sh", 'eval "docker run alpine:3"\n'),
        ("t.sh", "ssh host 'docker run alpine:3'\n"),
        ("t.sh", "ssh -o X=y host 'docker run alpine:3'\n"),
        ("t.sh", 'CMD="docker run alpine:3"\n'),
    ],
    "command-ssh": [
        ("t.sh", "ssh user@host docker pull alpine:3\n"),
        ("t.sh", "ssh -t host docker pull alpine:3\n"),
        ("t.sh", 'ssh -i key user@host "docker pull alpine:3"\n'),
        ("t.sh", "ssh \"$HOST\" 'docker pull alpine:3'\n"),
        ("t.sh", "ssh user@\"$HOST\" 'docker pull alpine:3'\n"),
        ("t.sh", 'ssh "${HOST}" "docker run --rm alpine:3 id"\n'),
        ("t.sh", "ssh -i \"$KEY\" user@host 'docker pull alpine:3'\n"),
        ("t.sh", 'ssh -o "StrictHostKeyChecking=no" host "docker pull alpine:3"\n'),
    ],
    "command-yaml-quoted": [
        ("w.yml", '- run: "docker run alpine:3"\n'),
        ("w.yml", "- run: 'docker run alpine:3'\n"),
        ("w.yml", '- run: "FOO=1 docker run alpine:3"\n'),
        ("w.yml", '    command: "docker run alpine:3"\n'),
    ],
    "command-forms": [
        ("t.sh", "/usr/bin/docker run alpine:3\n"),
        ("t.sh", "$DOCKER run alpine:3\n"),
        ("t.sh", "${DOCKER} run alpine:3\n"),
        ("Makefile", "t:\n\t$(DOCKER) run alpine:3\n"),
        ("Makefile", "X := $(shell docker run alpine:3)\n"),
    ],
    "command-case-arm": [
        ("t.sh", "case $1 in\n  a) docker run alpine:3 ;;\nesac\n"),
        ("t.sh", "case $1 in\n  a) FOO=1 docker run alpine:3 ;;\nesac\n"),
    ],
    "operand-substitution": [
        ("t.sh", "docker run --rm -u $(id -u):$(id -g) alpine:3 id\n"),
        ("t.sh", "docker run --rm --name x-$(date +%s) alpine:3 true\n"),
        ("t.sh", "docker run --rm -v $(realpath .):/w alpine:3 true\n"),
        ("t.sh", "docker run --rm -e FOO=$(cat f) alpine:3 true\n"),
        ("Makefile", "t:\n\tdocker run --rm -u $(shell id -u) alpine:3 id\n"),
        ("w.yml", "- run: docker run --rm -u $(id -u):$(id -g) alpine:3 id\n"),
        ("t.sh", "docker run --rm -e 'X=`' alpine:3 id\n"),
        ("t.sh", "docker run --rm -e 'X=$(echo a b' alpine:3 id\n"),
    ],
    "operand-redirect": [("t.sh", "docker run --rm 2>/dev/null alpine:3 true\n")],
    "makefile-recipe": [("Makefile", f"t:\n\t{r}docker run alpine:3\n") for r in ("", "@", "-", "+")]
    + [("Makefile", "t:\n\t@$(DOCKER) run alpine:3\n")],
    "build-context": [("t.sh", "docker buildx build --build-context b=docker-image://alpine:3 .\n")],
    "cache-from": [
        ("t.sh", "docker buildx build --cache-from type=registry,ref=quay.io/x/c:1 .\n"),
        ("t.sh", "docker buildx build --cache-from quay.io/x/c:1 .\n"),
    ],
    "build-arg": [("t.sh", "docker build --build-arg BASE=node:20 .\n")],
    "code-strings": [("x.ts", "run('mysql:8.0'); // docker\n"), ("x.ts", "\n" * 20 + "const X = 'mysql:8.0';\n")],
    "code-command-string": [
        ("x.ts", "execSync('docker run --rm postgres:17 psql');\n"),
        ("x.ts", "execSync('FOO=1 docker run --rm node:20 true');\n"),
        ("package.json", '{"scripts":{"t":"npm run b && docker run --rm node:20 true"}}\n'),
        ("x.ts", "execSync(`cd ${dir} && docker pull alpine:3`);\n"),
        ("x.ts", "await sh(`set -e; docker pull alpine:3`);\n"),
        ("x.ts", "exec(`cd ${d} && docker pull alpine:3`).then(x);\n"),
    ],
}


class ClaimsTableTests(unittest.TestCase):
    """Every coverage claim in the guard's doc has a row here, and the guard meets each row.

    The doc's "What it reads" bullets end with `[claim: id, id]`. A bullet with no
    id, an id with no row, or a row with no id is a failure, so a claim cannot be
    written down without a construction the guard is shown to flag.
    """

    DOC = HERE / "assert-image-refs-on-mirror.md"

    def bullets(self):
        text = self.DOC.read_text()
        section = text.split("## What it reads", 1)[1].split("\n## ", 1)[0]
        bullets = [b for b in re.split(r"\n(?=- )", section) if b.startswith("- ")]
        return [re.sub(r"\s+", " ", b) for b in bullets]

    def doc_ids(self):
        ids = []
        for bullet in self.bullets():
            for tag in re.findall(r"\[claim: ([a-z0-9, -]+)\]", bullet):
                ids += [i.strip() for i in tag.split(",")]
        return ids

    def test_limits_open_with_the_closing_sentence(self):
        text = re.sub(r"\s+", " ", self.DOC.read_text())
        limits = text.split("## Limits", 1)[1]
        self.assertTrue(
            limits.lstrip().startswith(
                "**The guard reads exactly the forms listed under What it reads. A spelling not listed is not "
                "promised: it may be reported (the guard also reads `script:`, `cmd:` and `entrypoint:` scalars, a "
                "leading `!` or `{ ...; }`, and `docker container run`) or silently missed: a green enforce run "
                "proves only that no listed form was found.**"
            )
        )

    def test_modes_state_what_a_miss_costs(self):
        text = re.sub(r"\s+", " ", self.DOC.read_text())
        modes = text.split("## Modes", 1)[1].split("## Limits", 1)[0]
        self.assertIn("In warn mode nothing breaks", modes)
        self.assertIn("In enforce mode the same miss gives false confidence", modes)

    def test_every_bullet_carries_a_claim_tag(self):
        untagged = [b.split("\n")[0][:70] for b in self.bullets() if not re.search(r"\[claim: [a-z0-9, -]+\]", b)]
        self.assertEqual(untagged, [])
        self.assertTrue(self.bullets())

    def test_the_doc_ids_and_the_table_rows_are_the_same_set(self):
        ids = self.doc_ids()
        self.assertEqual(len(ids), len(set(ids)), "an id is claimed twice")
        self.assertEqual(sorted(set(ids) - set(CLAIMS)), [], "claimed in the doc, no row here")
        self.assertEqual(sorted(set(CLAIMS) - set(ids)), [], "a row here that the doc does not claim")

    def test_the_guard_flags_a_minimal_construction_of_each_claim(self):
        for claim, constructions in CLAIMS.items():
            self.assertTrue(constructions, claim)
            for path, text in constructions:
                kinds = [k for _, _, k in found({path: text})]
                self.assertTrue(kinds, f"{claim}: not reported: {path!r} {text!r}")
                self.assertNotIn("unresolved", kinds, f"{claim}: not read: {path!r} {text!r}")


if __name__ == "__main__":
    unittest.main()
