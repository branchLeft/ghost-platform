"""Tests that every copy of the reserved tenant-name list agrees with the
register, registers/tenant-names.json, and that the workflow refuses a
registered name.

The copies are the generated blocks in infra/tenant/naming.ts and
render-core/src/naming.ts, the infrastructure names read by
app/provision/provision_tenant_volume.py and render-media-bucket-policy.py, and
the register lookup in the 'Validate inputs' step of
.github/workflows/provision-tenant.yml. The workflow block is run under
`bash -e`, not matched as text. A red copy with the jq lookup removed runs
beside the real block: the test fails if the red copy is not accepted-through,
which is how this file proves it can see the mechanism missing.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from types import ModuleType

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPTS_DIR = pathlib.Path(__file__).resolve().parent
REGISTER = REPO_ROOT / "registers" / "tenant-names.json"
SYNC_SCRIPT = REPO_ROOT / "scripts" / "sync-tenant-name-register.py"
INFRA_TENANT_NAMING = REPO_ROOT / "infra" / "tenant" / "naming.ts"
RENDER_CORE_NAMING = REPO_ROOT / "render-core" / "src" / "naming.ts"
APP_COPY = REPO_ROOT / "app" / "provision" / "provision_tenant_volume.py"
BUCKET_COPY = SCRIPTS_DIR / "render-media-bucket-policy.py"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "provision-tenant.yml"

VALIDATE_STEP = "Validate inputs"
STEP_LINE = re.compile(r"^      - name: (.+)$")
JOB_KEY_LINE = re.compile(r"^  [A-Za-z_][A-Za-z0-9_-]*:")
BLOCK_OPENING = 'REGISTER="${GITHUB_WORKSPACE:-}/registers/tenant-names.json"'
LOOKUP_PREFIX = "KIND="
FAIL_PRELUDE = 'fail() { echo "::error::$1"; exit 1; }\n'
GENERATED_ENTRY = re.compile(r"\{ name: '([^']+)', kind: '([a-z]+)'")


def _read_text(path: pathlib.Path) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _load_module(name: str, path: pathlib.Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def register_names(kind: str | None = None) -> list[str]:
    data = json.loads(_read_text(REGISTER))
    return [e["name"] for e in data["names"] if kind is None or e["kind"] == kind]


def _step_lines(lines: list[str], name: str) -> list[str]:
    """The lines of one step, from its `- name:` line up to the next step
    or the next job-level key."""
    start = None
    for i, line in enumerate(lines):
        m = STEP_LINE.match(line)
        if m and m.group(1) == name:
            start = i
            break
    if start is None:
        raise AssertionError(f"step {name!r} not found in the workflow")
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if STEP_LINE.match(lines[j]) or JOB_KEY_LINE.match(lines[j]):
            end = j
            break
    return lines[start:end]


def _run_body(step: list[str]) -> list[str]:
    """The `run: |` block of a step, dedented by its 10-space body indent."""
    body = []
    inside = False
    for line in step:
        if not inside:
            if line == "        run: |":
                inside = True
            continue
        if line.strip() == "" or line.startswith("          "):
            body.append(line[10:] if line.strip() else "")
        else:
            break
    if not body:
        raise AssertionError("no `run: |` body found in the step")
    return body


def workflow_register_block(workflow_yaml: str) -> list[str]:
    """The register check, from the REGISTER assignment through the `fi`
    that closes the refusal."""
    body = _run_body(_step_lines(workflow_yaml.splitlines(), VALIDATE_STEP))
    start = None
    for i, line in enumerate(body):
        if line.strip() == BLOCK_OPENING:
            start = i
            break
    if start is None:
        raise AssertionError(f"no {BLOCK_OPENING!r} line in the validation step")
    for j in range(start + 1, len(body)):
        if body[j] == "fi":
            return body[start : j + 1]
    raise AssertionError("the register check has no closing fi")


def red_copy(block: list[str]) -> list[str]:
    """The block with the jq lookup of the name removed."""
    kept = [line for line in block if not line.startswith(LOOKUP_PREFIX)]
    if len(kept) == len(block):
        raise AssertionError("the block has no lookup line to remove")
    return kept


def _run_block(
    block: list[str], tenant: str, workspace: str | None
) -> tuple[int, str]:
    """Run a register-check block with TENANT set and GITHUB_WORKSPACE pointing
    at `workspace` (unset when None). Returns (returncode, combined output)."""
    script = FAIL_PRELUDE + "\n".join(block) + "\n"
    env = dict(os.environ)
    env["TENANT"] = tenant
    env.pop("GITHUB_WORKSPACE", None)
    if workspace is not None:
        env["GITHUB_WORKSPACE"] = workspace
    with tempfile.TemporaryDirectory(prefix="reserved-names-") as directory:
        path = os.path.join(directory, "check.sh")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(script)
        proc = subprocess.run(
            ["bash", "-e", path],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
    return proc.returncode, proc.stdout + proc.stderr


def _real_block() -> list[str]:
    return workflow_register_block(_read_text(WORKFLOW))


def generated_names(naming_ts: str) -> list[tuple[str, str]]:
    start = naming_ts.find("// BEGIN GENERATED FROM registers/tenant-names.json")
    end = naming_ts.find("// END GENERATED FROM registers/tenant-names.json")
    if start == -1 or end == -1 or end < start:
        raise AssertionError("generated block markers missing in naming.ts")
    return GENERATED_ENTRY.findall(naming_ts[start:end])


def _app_copy_names() -> tuple[str, ...]:
    module = _load_module("reserved_names_app_copy", APP_COPY)
    return tuple(module.reserved_stack_names())


def _bucket_copy_names() -> frozenset[str]:
    scripts = str(SCRIPTS_DIR)
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    module = _load_module("reserved_names_bucket_copy", BUCKET_COPY)
    return frozenset(module.reserved_slugs())


class RegisterIsRead(unittest.TestCase):
    def test_register_is_read(self) -> None:
        # A control: the parser must find the real register, or every test
        # below passes against an empty set.
        names = register_names()
        self.assertGreaterEqual(len(names), 7, names)
        self.assertIn("mail-spool", register_names("infrastructure"))
        self.assertEqual(register_names("tenant"), ["blog"])


class EveryCopyAgreesWithTheRegister(unittest.TestCase):
    def _expected_generated(self) -> list[tuple[str, str]]:
        data = json.loads(_read_text(REGISTER))
        return [(e["name"], e["kind"]) for e in data["names"]]

    def test_infra_tenant_generated_block_matches(self) -> None:
        self.assertEqual(
            generated_names(_read_text(INFRA_TENANT_NAMING)), self._expected_generated()
        )

    def test_render_core_generated_block_matches(self) -> None:
        self.assertEqual(
            generated_names(_read_text(RENDER_CORE_NAMING)), self._expected_generated()
        )

    def test_app_provision_names_match(self) -> None:
        self.assertEqual(
            set(_app_copy_names()),
            set(register_names("infrastructure")),
            "app/provision reserved names differ from the register",
        )

    def test_media_bucket_policy_names_match(self) -> None:
        self.assertEqual(
            set(_bucket_copy_names()),
            set(register_names("infrastructure")),
            "render-media-bucket-policy reserved names differ from the register",
        )

    def test_sync_script_check_passes(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(SYNC_SCRIPT), "--check"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


class WorkflowRegisterBlockBehaviour(unittest.TestCase):
    def test_refuses_every_registered_name(self) -> None:
        # Tenant zero included: it is not provisioned through this workflow.
        for name in register_names():
            with self.subTest(tenant=name):
                rc, out = _run_block(_real_block(), name, str(REPO_ROOT))
                self.assertNotEqual(rc, 0, out)
                self.assertIn("tenant_name is already registered", out)

    def test_accepts_an_unregistered_name(self) -> None:
        # The control case: the refusal is the lookup, not a blanket failure.
        for name in ("demo-1", "acme-news"):
            with self.subTest(tenant=name):
                rc, out = _run_block(_real_block(), name, str(REPO_ROOT))
                self.assertEqual(rc, 0, out)

    def test_refuses_when_the_workspace_is_unset(self) -> None:
        rc, out = _run_block(_real_block(), "demo-1", None)
        self.assertNotEqual(rc, 0, out)
        self.assertIn("missing or unreadable", out)

    def test_refuses_when_the_register_is_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="reserved-names-ws-") as workspace:
            rc, out = _run_block(_real_block(), "demo-1", workspace)
        self.assertNotEqual(rc, 0, out)
        self.assertIn("missing or unreadable", out)

    def test_refuses_when_the_register_is_not_valid(self) -> None:
        # A malformed register must refuse, not read as "nothing registered".
        for text in ("not json", '{"names": "website"}', '{"version": 1}'):
            with self.subTest(register=text):
                with tempfile.TemporaryDirectory(prefix="reserved-names-ws-") as workspace:
                    registers = pathlib.Path(workspace) / "registers"
                    registers.mkdir()
                    (registers / "tenant-names.json").write_text(text, encoding="utf-8")
                    rc, out = _run_block(_real_block(), "website", workspace)
                self.assertNotEqual(rc, 0, out)
                self.assertIn("not valid", out)


class RedCopyIsSeen(unittest.TestCase):
    """Red beside green: with the jq lookup removed, a registered name gets
    through. The real block (green, above) refuses it; this is the same test
    pointed at the broken mechanism, and it must be seen to fail."""

    def test_red_copy_lets_a_registered_name_through(self) -> None:
        broken = red_copy(_real_block())
        self.assertNotEqual(broken, _real_block())
        for name in register_names():
            with self.subTest(tenant=name):
                rc, out = _run_block(broken, name, str(REPO_ROOT))
                self.assertEqual(rc, 0, "the red copy should accept: " + out)

    def test_real_block_refuses_what_the_red_copy_accepts(self) -> None:
        for name in register_names("infrastructure"):
            with self.subTest(tenant=name):
                red_rc, _ = _run_block(red_copy(_real_block()), name, str(REPO_ROOT))
                green_rc, out = _run_block(_real_block(), name, str(REPO_ROOT))
                self.assertEqual(red_rc, 0)
                self.assertNotEqual(green_rc, 0, out)


class DriftIsCaught(unittest.TestCase):
    def test_a_hand_edit_to_a_generated_block_is_reported(self) -> None:
        # A control: the sync script's own self-test proves its check sees drift.
        proc = subprocess.run(
            [sys.executable, str(SYNC_SCRIPT), "--self-test"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_a_missing_name_in_a_copy_is_reported(self) -> None:
        text = _read_text(RENDER_CORE_NAMING)
        drifted = text.replace(
            "  { name: 'mail-spool', kind: 'infrastructure' },\n", ""
        )
        self.assertNotEqual(drifted, text, "the drift edit did not change the text")
        data = json.loads(_read_text(REGISTER))
        expected = [(e["name"], e["kind"]) for e in data["names"]]
        self.assertNotEqual(generated_names(drifted), expected)


if __name__ == "__main__":
    unittest.main()
