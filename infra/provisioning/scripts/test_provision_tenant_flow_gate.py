"""Tests for the FLOW_READY kill-switch in ../../../.github/workflows/
provision-tenant.yml -- the step that refuses to provision any tenant unless
the TENANT_PROVISIONING_FLOW_HETZNERISED repository variable is exactly
"true".

Nothing else in this repository referenced FLOW_READY before this file
(branchLeft/workspace#511): the control that stops all tenant creation was
defended only by a human reading the YAML.

This file lives beside the other provisioning guard tests so
`python3 -m unittest discover -s scripts -p 'test_*.py'` -- already run by
infra-platform-ci.yml's `provisioning-typecheck` job -- picks it up with no
workflow change. It differs from its neighbours in reading the *workflow*
file rather than importing a script under test: the gate lives entirely as
inline shell in the YAML, with no extracted module to import.

The gate is tested by extracting its literal `run:` block from the workflow
source and executing it with `bash -c` under different FLOW_READY values,
rather than by pattern-matching the YAML text. A textual check can be
satisfied by a comparison that reads right and behaves differently (a
case-insensitive match, a truthy check); running the real script is the only
way to pin the behaviour rather than its spelling.
"""

import os
import re
import subprocess
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
# scripts/ -> provisioning/ -> infra/ -> repo root
_REPO_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", ".."))
_WORKFLOW_PATH = os.path.join(
    _REPO_ROOT, ".github", "workflows", "provision-tenant.yml")

GATE_STEP_NAME = "Refuse to provision through a half-migrated flow"

# The first step in the job that actually creates or writes anything, as
# opposed to reading state and validating it. If a refactor ever moves the
# gate below this step, tenant creation is no longer refused before it can
# start -- the property the issue calls the one that is not survivable.
FIRST_MUTATING_STEP_NAME = "Generate the tenant repo from the template"


def _read_workflow():
    with open(_WORKFLOW_PATH, encoding="utf-8") as fh:
        return fh.read()


def _steps_block(workflow_text):
    """The raw text of the `provision` job's `steps:` list.

    Scoped to this one block, rather than searching the whole file, so a
    `- name:` appearing in a *different* job (there is only one today) could
    never be mistaken for a step of this one.
    """
    match = re.search(r"\n    steps:\n(.*)\Z", workflow_text, re.DOTALL)
    if not match:
        raise AssertionError(
            "could not find a job-level 'steps:' block in "
            f"{_WORKFLOW_PATH} -- has the job structure changed?")
    return match.group(1)


def _step_names(steps_block):
    """Step names in the order they appear, top to bottom."""
    names = re.findall(r"^      - name: (.+)$", steps_block, re.MULTILINE)
    if not names:
        raise AssertionError(
            "found no '      - name: ...' step headers -- the indentation "
            "assumption in this test no longer matches the workflow")
    return names


def _step_body(steps_block, name):
    """Raw YAML lines belonging to one named step, up to the next step or
    the end of the block."""
    pattern = re.compile(
        r"^      - name: " + re.escape(name) + r"\n(.*?)(?=\n      - name: |\Z)",
        re.DOTALL | re.MULTILINE,
    )
    match = pattern.search(steps_block)
    if not match:
        raise AssertionError(f"step {name!r} not found in the workflow")
    return match.group(1)


def _run_script(step_body):
    """The literal shell text of a step's `run: |` block, dedented."""
    match = re.search(r"^        run: \|\n(.*)", step_body, re.DOTALL | re.MULTILINE)
    if not match:
        raise AssertionError("this step has no 'run: |' block to extract")
    lines = []
    for line in match.group(1).splitlines():
        if line.startswith(" " * 10):
            lines.append(line[10:])
        elif line.strip() == "":
            lines.append("")
        else:
            # A line at a shallower indent is the next YAML key: the block
            # scalar has ended.
            break
    script = "\n".join(lines)
    if not script.strip():
        raise AssertionError("extracted an empty run script -- indentation "
                              "assumption is probably wrong")
    return script


def _gate_script():
    steps_block = _steps_block(_read_workflow())
    body = _step_body(steps_block, GATE_STEP_NAME)
    return _run_script(body)


def _run_gate(flow_ready=None, unset=False):
    """Execute the gate's actual extracted shell against a FLOW_READY value.

    Returns (returncode, combined stdout+stderr). `unset=True` deletes the
    variable from the environment entirely, rather than setting it to "" --
    the workflow's own `${{ vars.X }}` expands an unset repository variable
    to the empty string, so this is exercised as its own case rather than
    assumed identical.
    """
    script = _gate_script()
    env = dict(os.environ)
    env.pop("FLOW_READY", None)
    if not unset:
        env["FLOW_READY"] = "" if flow_ready is None else flow_ready
    proc = subprocess.run(
        ["bash", "-c", script],
        env=env,
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


class TheGateExistsAndRunsFirst(unittest.TestCase):
    """Deliberately does not require the gate to be literally the first step
    in the job. The workflow's own comment on the step immediately after it
    says moving the credential-free checkout earlier "changes nothing about
    what 'before anything is created' protects" -- and the issue draws the
    same line: reordering past checkout, credential-scoping or validation is
    survivable, only reordering past the first state-creating step is not.
    A test that required index 0 would fail the moment anyone exercised that
    documented flexibility, on a property nobody claims matters."""

    def test_the_gate_step_exists(self):
        names = _step_names(_steps_block(_read_workflow()))
        self.assertIn(GATE_STEP_NAME, names)

    def test_the_gate_precedes_the_first_step_that_creates_anything(self):
        names = _step_names(_steps_block(_read_workflow()))
        self.assertIn(FIRST_MUTATING_STEP_NAME, names)
        gate_index = names.index(GATE_STEP_NAME)
        mutating_index = names.index(FIRST_MUTATING_STEP_NAME)
        self.assertLess(
            gate_index, mutating_index,
            "the gate has moved to after the step that creates the "
            "tenant's repository -- a half-migrated flow could now create "
            "state before being refused")


class TheComparisonIsStrict(unittest.TestCase):
    """The six input cases the issue's originating review simulated against
    `origin/main`: only the literal string "true" is allowed through."""

    def test_the_literal_string_true_is_allowed_through(self):
        rc, _ = _run_gate("true")
        self.assertEqual(rc, 0)

    def test_empty_string_is_refused(self):
        rc, _ = _run_gate("")
        self.assertEqual(rc, 1)

    def test_upper_case_true_is_refused(self):
        rc, _ = _run_gate("TRUE")
        self.assertEqual(rc, 1)

    def test_title_case_true_is_refused(self):
        rc, _ = _run_gate("True")
        self.assertEqual(rc, 1)

    def test_true_with_trailing_whitespace_is_refused(self):
        rc, _ = _run_gate("true ")
        self.assertEqual(rc, 1)

    def test_the_numeral_one_is_refused(self):
        rc, _ = _run_gate("1")
        self.assertEqual(rc, 1)

    def test_the_literal_string_false_is_refused(self):
        rc, _ = _run_gate("false")
        self.assertEqual(rc, 1)

    def test_the_unset_variable_is_refused(self):
        """GitHub expands an unset `vars.X` to "", so this is the same case
        as the empty string above -- exercised directly rather than assumed,
        because an unset shell variable under `set -u` would behave
        differently, and this step does not declare `set -u`."""
        rc, _ = _run_gate(unset=True)
        self.assertEqual(rc, 1)


class RefusalFailsClosed(unittest.TestCase):
    """An `::error::` annotation with no non-zero exit is a red line in the
    log and a green run -- the fourth property the issue names."""

    def test_a_refusal_exits_non_zero(self):
        rc, _ = _run_gate("")
        self.assertNotEqual(rc, 0)

    def test_a_refusal_prints_an_error_annotation(self):
        _, output = _run_gate("")
        self.assertIn("::error::", output)

    def test_an_allowed_run_prints_no_error_annotation(self):
        _, output = _run_gate("true")
        self.assertNotIn("::error::", output)


if __name__ == "__main__":
    unittest.main()
