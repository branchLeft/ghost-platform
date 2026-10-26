"""Tests that the three copies of the reserved tenant-name list agree with
render-core's source list, RESERVED_STACK_NAMES in render-core/src/naming.ts.

The copies are RESERVED_STACK_NAMES in app/provision/provision_tenant_volume.py,
RESERVED_SLUGS in render-media-bucket-policy.py, and the `case` block of the
'Validate inputs' step in .github/workflows/provision-tenant.yml. The workflow
block is run under `bash -e`, not matched as text.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Iterable
from types import ModuleType

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPTS_DIR = pathlib.Path(__file__).resolve().parent
RENDER_CORE_NAMING = REPO_ROOT / "render-core" / "src" / "naming.ts"
APP_COPY = REPO_ROOT / "app" / "provision" / "provision_tenant_volume.py"
BUCKET_COPY = SCRIPTS_DIR / "render-media-bucket-policy.py"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "provision-tenant.yml"

VALIDATE_STEP = "Validate inputs"
RENDER_CORE_DECLARATION = "RESERVED_STACK_NAMES: readonly string[] = ["
SINGLE_QUOTED_NAME = re.compile(r"'([^']+)'")
STEP_LINE = re.compile(r"^      - name: (.+)$")
JOB_KEY_LINE = re.compile(r"^  [A-Za-z_][A-Za-z0-9_-]*:")
CASE_OPENING = 'case "$TENANT" in'
FAIL_PRELUDE = 'fail() { echo "::error::$1"; exit 1; }\n'


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


def parse_render_core_names(render_core_ts: str) -> list[str]:
    start = render_core_ts.find(RENDER_CORE_DECLARATION)
    if start == -1:
        raise AssertionError(f"{RENDER_CORE_DECLARATION!r} not found in naming.ts")
    body_start = start + len(RENDER_CORE_DECLARATION)
    body_end = render_core_ts.find("]", body_start)
    if body_end == -1:
        raise AssertionError("RESERVED_STACK_NAMES has no closing ] in naming.ts")
    return SINGLE_QUOTED_NAME.findall(render_core_ts[body_start:body_end])


def _validate_step_body(workflow_yaml: str) -> list[str]:
    lines = workflow_yaml.splitlines()
    return _run_body(_step_lines(lines, VALIDATE_STEP))


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


def _case_opening_index(body: list[str]) -> int:
    for i, line in enumerate(body):
        if line.strip() == CASE_OPENING:
            return i
    raise AssertionError(f"no {CASE_OPENING!r} line in the validation step")


def parse_workflow_names(workflow_yaml: str) -> list[str]:
    body = _validate_step_body(workflow_yaml)
    opening = _case_opening_index(body)
    if opening + 1 >= len(body):
        raise AssertionError("the tenant case block has no pattern line")
    pattern = body[opening + 1].strip()
    if not pattern.endswith(")"):
        raise AssertionError(
            f"the tenant case pattern must sit on one line ending in ')': {pattern!r}"
        )
    return [name.strip() for name in pattern[:-1].split("|")]


def workflow_case_block(workflow_yaml: str) -> list[str]:
    """The tenant `case` block, from its opening line through its `esac`."""
    body = _validate_step_body(workflow_yaml)
    start = _case_opening_index(body)
    for j in range(start + 1, len(body)):
        if body[j].strip() == "esac":
            return body[start : j + 1]
    raise AssertionError("the tenant case block has no closing esac")


def compare_reserved_names(
    render_core_ts: str,
    app_copy: Iterable[str],
    bucket_copy: Iterable[str],
    workflow_yaml: str,
) -> list[str]:
    expected = set(parse_render_core_names(render_core_ts))
    sources = (
        ("app copy", set(app_copy)),
        ("bucket-policy copy", set(bucket_copy)),
        ("workflow case block", set(parse_workflow_names(workflow_yaml))),
    )
    problems = []
    for source, names in sources:
        line = _difference_line(source, names, expected)
        if line is not None:
            problems.append(line)
    return problems


def _difference_line(source: str, names: set[str], expected: set[str]) -> str | None:
    missing = sorted(expected - names)
    extra = sorted(names - expected)
    if not missing and not extra:
        return None
    clauses = []
    if missing:
        clauses.append(f"missing {', '.join(missing)}")
    if extra:
        clauses.append(f"extra {', '.join(extra)}")
    return f"{source} differs from render-core: {'; '.join(clauses)}"


def _app_copy_names() -> tuple[str, ...]:
    module = _load_module("reserved_names_app_copy", APP_COPY)
    return tuple(module.RESERVED_STACK_NAMES)


def _bucket_copy_names() -> frozenset[str]:
    scripts = str(SCRIPTS_DIR)
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    module = _load_module("reserved_names_bucket_copy", BUCKET_COPY)
    return frozenset(module.RESERVED_SLUGS)


def _run_workflow_block(tenant: str) -> tuple[int, str]:
    """Run the workflow's tenant case block with TENANT set. Returns
    (returncode, combined output)."""
    block = workflow_case_block(_read_text(WORKFLOW))
    script = FAIL_PRELUDE + "\n".join(block) + "\n"
    env = dict(os.environ)
    env["TENANT"] = tenant
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


class RenderCoreListIsRead(unittest.TestCase):
    def test_render_core_list_is_read(self) -> None:
        # A control: the parser must find the real list, or every test
        # below passes against an empty set.
        names = parse_render_core_names(_read_text(RENDER_CORE_NAMING))
        self.assertEqual(len(names), 6, names)
        self.assertIn("mail-spool", names)
        self.assertNotIn("blog", names)


class EveryCopyAgreesWithRenderCore(unittest.TestCase):
    def test_app_provision_copy_matches_render_core(self) -> None:
        expected = set(parse_render_core_names(_read_text(RENDER_CORE_NAMING)))
        self.assertEqual(
            set(_app_copy_names()),
            expected,
            "app/provision RESERVED_STACK_NAMES differs from render-core",
        )

    def test_media_bucket_policy_copy_matches_render_core(self) -> None:
        expected = set(parse_render_core_names(_read_text(RENDER_CORE_NAMING)))
        self.assertEqual(
            set(_bucket_copy_names()),
            expected,
            "render-media-bucket-policy RESERVED_SLUGS differs from render-core",
        )

    def test_workflow_case_block_matches_render_core(self) -> None:
        expected = set(parse_render_core_names(_read_text(RENDER_CORE_NAMING)))
        self.assertEqual(
            set(parse_workflow_names(_read_text(WORKFLOW))),
            expected,
            "the provision-tenant.yml case block differs from render-core",
        )


class WorkflowCaseBlockBehaviour(unittest.TestCase):
    def test_workflow_case_block_refuses_each_name_and_accepts_blog(self) -> None:
        names = parse_render_core_names(_read_text(RENDER_CORE_NAMING))
        for name in names:
            with self.subTest(tenant=name):
                rc, out = _run_workflow_block(name)
                self.assertNotEqual(rc, 0, out)
                self.assertIn("tenant_name is reserved", out)
        for name in ("blog", "demo-1"):
            with self.subTest(tenant=name):
                rc, out = _run_workflow_block(name)
                self.assertEqual(rc, 0, out)


class DriftIsCaught(unittest.TestCase):
    def test_drift_in_the_workflow_block_is_caught(self) -> None:
        # A control: removing a name from the workflow copy must be reported.
        render_core = _read_text(RENDER_CORE_NAMING)
        workflow = _read_text(WORKFLOW)
        drifted = workflow.replace(" | mail-spool)", ")")
        self.assertNotEqual(drifted, workflow, "the drift edit did not change the text")
        problems = compare_reserved_names(
            render_core, _app_copy_names(), _bucket_copy_names(), drifted
        )
        self.assertTrue(problems)
        self.assertTrue(
            any(
                "mail-spool" in line and "workflow case block" in line
                for line in problems
            ),
            problems,
        )

    def test_drift_in_render_core_is_caught(self) -> None:
        # A control: a name render-core adds that no copy has must be reported.
        render_core = _read_text(RENDER_CORE_NAMING)
        drifted = render_core.replace("  'website',", "  'website',\n  'extra-stack',")
        self.assertNotEqual(
            drifted, render_core, "the drift edit did not change the text"
        )
        problems = compare_reserved_names(
            drifted, _app_copy_names(), _bucket_copy_names(), _read_text(WORKFLOW)
        )
        self.assertTrue(problems)
        self.assertTrue(any("extra-stack" in line for line in problems), problems)


if __name__ == "__main__":
    unittest.main()
