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

Running the script is necessary and not sufficient, though, and the second
half of this file is why. Whether the gate refuses a bad value and whether
the *job* stops are different questions: a step's `if:`, its
`continue-on-error:`, what its `env:` binds FLOW_READY to, and which job
holds the steps that create state all sit outside the script and decide
whether its `exit 1` reaches anything. Each of those four was applied to
provision-tenant.yml in a worktree and left every behavioural assertion here
green while the gate was, in effect, open. The assertions that close them
read the YAML around the step deliberately -- that surface has no runtime to
execute.
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

# The job the gate and every provisioning step belong to.
GATE_JOB_NAME = "provision"

# The first step in the job that actually creates or writes anything, as
# opposed to reading state and validating it. If a refactor ever moves the
# gate below this step, tenant creation is no longer refused before it can
# start -- the property the issue calls the one that is not survivable.
FIRST_MUTATING_STEP_NAME = "Generate the tenant repo from the template"

# The step's `env:` mapping, verbatim. The extracted shell reads $FLOW_READY
# and nothing else, so what that name is bound to is half the control and is
# invisible to any test that only runs the script: rebinding it to a literal
# leaves every behavioural assertion below green and the gate permanently
# open.
FLOW_READY_BINDING = (
    "FLOW_READY: ${{ vars.TENANT_PROVISIONING_FLOW_HETZNERISED }}")

# Everything a gate step is allowed to carry. An allowlist rather than a
# denylist of the two keys known to defeat it (`if:`, which skips the step
# entirely, and `continue-on-error:`, which turns its `exit 1` into a green
# run): a key nobody has thought about yet on the one step that stops all
# tenant creation should stop this test, not slip past it. Widening it is a
# one-line change made deliberately.
ALLOWED_GATE_STEP_KEYS = frozenset({"env", "run"})


def _read_workflow():
    with open(_WORKFLOW_PATH, encoding="utf-8") as fh:
        return fh.read()


def _job_names(workflow_text):
    """Top-level job keys, in file order."""
    match = re.search(r"^jobs:\n(.*)\Z", workflow_text, re.DOTALL | re.MULTILINE)
    if not match:
        raise AssertionError(f"{_WORKFLOW_PATH} declares no 'jobs:' mapping")
    names = re.findall(r"^  ([A-Za-z0-9_-]+):$", match.group(1), re.MULTILINE)
    if not names:
        raise AssertionError(
            "found no '  <job>:' keys under 'jobs:' -- the indentation "
            "assumption in this test no longer matches the workflow")
    return names


def _job_block(workflow_text, job_name):
    """The raw text of one job, up to the next top-level job key or EOF."""
    pattern = re.compile(
        r"^  " + re.escape(job_name) + r":\n(.*?)(?=^  [A-Za-z0-9_-]+:$|\Z)",
        re.DOTALL | re.MULTILINE,
    )
    match = pattern.search(workflow_text)
    if not match:
        raise AssertionError(
            f"{_WORKFLOW_PATH} declares no job named {job_name!r}")
    return match.group(1)


def _steps_block(workflow_text):
    """The raw text of the `provision` job's `steps:` list.

    Bounded at both ends -- the job's own `steps:` key, and the next
    top-level job key -- rather than running to end of file. An unbounded
    block silently spans every job below it, which makes the ordering
    assertion below satisfiable by moving a state-creating step into a
    *second* job that never runs the gate at all.
    """
    job = _job_block(workflow_text, GATE_JOB_NAME)
    match = re.search(r"^    steps:\n(.*)\Z", job, re.DOTALL | re.MULTILINE)
    if not match:
        raise AssertionError(
            f"the {GATE_JOB_NAME!r} job in {_WORKFLOW_PATH} has no 'steps:' "
            "block -- has the job structure changed?")
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


def _step_keys(step_body):
    """The step's own YAML keys, e.g. {"env", "run"}.

    Keys sit at eight spaces; the `run: |` block's own lines sit at ten, so
    a shell line reading `foo: bar` cannot be mistaken for one.
    """
    return set(re.findall(r"^        ([a-z][a-z-]*):", step_body, re.MULTILINE))


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

    def test_the_gate_and_every_provisioning_step_share_one_job(self):
        """`provision` is the only job in this workflow, and the ordering
        assertion below is only meaningful while that holds.

        A second job is not refused because two jobs are wrong -- it is
        refused because whether the new one is behind the gate depends on
        whether it declares `needs: provision`, which this test cannot
        decide for a job it has never seen. Splitting the workflow is a
        deliberate change that has to come back here and say how the gate
        still covers what moved."""
        self.assertEqual(
            _job_names(_read_workflow()), [GATE_JOB_NAME],
            "provision-tenant.yml no longer has exactly one job. A step that "
            "creates state in a job which does not run the gate -- or does "
            "not 'needs:' the job that does -- is not gated at all, and the "
            "ordering assertions in this class say nothing about it")

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


class TheGateCannotBeOpenedAroundItsScript(unittest.TestCase):
    """The fail-open half, and the half a behavioural test cannot reach.

    Everything above runs the gate's extracted shell and asserts what it
    does with a value. None of it can see the three ways to leave that
    shell byte-identical and still have the job provision a tenant: bind
    `FLOW_READY` to something that is always "true", skip the step with an
    `if:`, or soften its `exit 1` with `continue-on-error:`. Each was
    applied to the workflow in a worktree and left all thirteen behavioural
    assertions green, which is what these four exist for."""

    def _gate_body(self):
        return _step_body(_steps_block(_read_workflow()), GATE_STEP_NAME)

    def test_flow_ready_is_bound_to_the_repository_variable(self):
        """A step env of `FLOW_READY: 'true'` opens the gate for every run
        while the script under test still refuses everything but "true"."""
        env_block = re.search(
            r"^        env:\n(.*?)(?=^        \S|\Z)",
            self._gate_body(), re.DOTALL | re.MULTILINE)
        self.assertIsNotNone(
            env_block,
            "the gate step declares no env: block, so FLOW_READY is unset "
            "for every run -- which this gate refuses, but by accident "
            "rather than by reading the variable an owner sets")
        env_lines = re.findall(r"^          (\S.*)$", env_block.group(1),
                               re.MULTILINE)
        self.assertEqual(
            env_lines, [FLOW_READY_BINDING],
            "the gate step's env: no longer binds FLOW_READY to exactly "
            f"{FLOW_READY_BINDING!r} -- the variable an owner sets to open "
            "provisioning is not what the gate reads")

    def test_the_gate_step_is_not_skippable_by_a_condition(self):
        self.assertNotIn(
            "if", _step_keys(self._gate_body()),
            "the gate step carries an 'if:' -- a step that evaluates false "
            "is skipped, and a skipped step is a passed one to every step "
            "after it")

    def test_the_gate_step_is_not_soft_failed(self):
        self.assertNotIn(
            "continue-on-error", _step_keys(self._gate_body()),
            "the gate step carries 'continue-on-error:' -- its exit 1 no "
            "longer stops the job, so the refusal becomes a red annotation "
            "in front of a tenant that got created anyway")

    def test_the_gate_step_carries_nothing_else(self):
        self.assertEqual(
            _step_keys(self._gate_body()), set(ALLOWED_GATE_STEP_KEYS),
            "the gate step's keys have changed. Every key on this step is "
            "part of the control: decide what a new one does to a refusal "
            "before adding it to ALLOWED_GATE_STEP_KEYS")


if __name__ == "__main__":
    unittest.main()
