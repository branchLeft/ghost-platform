"""Tests for the FLOW_READY kill-switch in ../../../.github/workflows/
provision-tenant.yml -- the step that refuses to provision any tenant unless
the TENANT_PROVISIONING_FLOW_HETZNERISED repository variable is exactly
"true". Tests the gate by extracting its `run:` block and executing it,
never by pattern-matching the YAML text, and separately reads the YAML
around the step for what decides whether the *job* stops, which the script
itself cannot determine. See test_provision_tenant_flow_gate.md#module-overview.
"""

import atexit
import os
import re
import shutil
import subprocess
import tempfile
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

# Steps allowed to run BEFORE the gate. Empty, because the gate is the
# first step in the job today.
#
# An earlier version of this file asserted only "the gate precedes
# FIRST_MUTATING_STEP_NAME", which is weaker than it reads: a *new* step
# inserted above the gate is still above that named step, so a
# `gh repo create` added at the top of the job passes. There is no such
# thing as a step this file can prove creates nothing -- only a step
# somebody has read and decided creates nothing. Adding a name here is that
# decision, recorded once and in the open.
STEPS_ALLOWED_BEFORE_THE_GATE = ()

# Steps allowed to carry `if:` or `continue-on-error:`, either of which lets
# a step run or survive after the gate has already refused. `Summary` and the
# token revocation are the exceptions and create nothing; listed rather than pattern-matched
# since the idiom is already live elsewhere in this workflow.
# See test_provision_tenant_flow_gate.md#steps_allowed_to_survive_a_failed_predecessor.
STEPS_ALLOWED_TO_SURVIVE_A_FAILED_PREDECESSOR = ("Revoke the provisioning token", "Summary")

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


# A job key: two spaces, a name, a colon, optionally a trailing comment.
# The trailing-comment half is not cosmetic. Without it, appending
# `  # split out for readability` to a second job's key hid that job from
# every assertion in this file -- the job count looked like one, and the
# `provision` block ran on through the unrecognised key and swallowed the
# hidden job's steps, so a `gh repo create` sitting in an ungated parallel
# job still read as "after the gate".
_JOB_KEY = re.compile(r"^  ([A-Za-z0-9_-]+):[ \t]*(?:#.*)?$", re.MULTILINE)

# Anything at two spaces that is not blank and not a whole-line comment.
# Every one of these must be a job key this file can see; a shape it cannot
# parse -- a quoted key, a flow mapping -- has to stop the tests rather than
# be silently skipped, because being silently skipped is exactly how the
# trailing comment above got through.
_TWO_SPACE_LINE = re.compile(r"^  (?!\s)(?!#).*$", re.MULTILINE)


def _job_names(workflow_text):
    """Top-level job keys, in file order."""
    match = re.search(r"^jobs:\n(.*)\Z", workflow_text, re.DOTALL | re.MULTILINE)
    if not match:
        raise AssertionError(f"{_WORKFLOW_PATH} declares no 'jobs:' mapping")
    body = match.group(1)
    unparsed = [line for line in _TWO_SPACE_LINE.findall(body)
                if not _JOB_KEY.match(line)]
    if unparsed:
        raise AssertionError(
            "these lines sit at job-key indent under 'jobs:' but are not a "
            f"shape this file can read as a job key: {unparsed!r}. Refusing "
            "rather than skipping them: a job this file cannot see is a job "
            "it cannot say is behind the gate.")
    names = _JOB_KEY.findall(body)
    if not names:
        raise AssertionError(
            "found no '  <job>:' keys under 'jobs:' -- the indentation "
            "assumption in this test no longer matches the workflow")
    return names


def _job_block(workflow_text, job_name):
    """The raw text of one job, up to the next top-level job key or EOF."""
    pattern = re.compile(
        r"^  " + re.escape(job_name) + r":[ \t]*(?:#.*)?\n"
        r"(.*?)(?=^  [A-Za-z0-9_-]+:[ \t]*(?:#.*)?$|\Z)",
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
    """Step names in the order they appear, top to bottom.

    A step whose first key is not `name:` is refused rather than skipped.
    Every assertion below addresses a step by name, so an anonymous step is
    one this file cannot see at all -- and an unnamed `run: gh repo create`
    inserted above the gate was, before this check, entirely invisible to
    it.
    """
    anonymous = [line for line in re.findall(r"^      - .*$", steps_block,
                                             re.MULTILINE)
                 if not line.startswith("      - name: ")]
    if anonymous:
        raise AssertionError(
            f"these steps do not open with 'name:': {anonymous!r}. Refusing "
            "rather than skipping them: this file addresses every step by "
            "name, so an unnamed step is one it cannot reason about.")
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


def _step_keys_by_name(steps_block):
    """{step name: its YAML keys} for every step in the job, in order."""
    return {name: _step_keys(_step_body(steps_block, name))
            for name in _step_names(steps_block)}


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


_SCRIPT_FILES = {}


def _script_file(script):
    """A file holding `script`, reused across calls with the same text.

    Keyed on the text so a caller can never be handed a stale script; the
    only reason it is cached at all is that creating and tearing down a
    temporary directory per invocation costs ~0.3s on macOS, which turned
    this file from the fastest in the suite into the slowest.
    """
    path = _SCRIPT_FILES.get(script)
    if path is None:
        directory = tempfile.mkdtemp(prefix="flow-ready-gate-")
        atexit.register(shutil.rmtree, directory, True)
        path = os.path.join(directory, "gate.sh")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(script)
        _SCRIPT_FILES[script] = path
    return path


def _run_gate(flow_ready=None, unset=False):
    """Execute the gate's actual extracted shell against a FLOW_READY value.
    Returns (returncode, combined stdout+stderr). Run as `bash -e <file>`,
    what a `run:` block with no `shell:` key gets on a Linux runner.
    See test_provision_tenant_flow_gate.md#_run_gate.
    """
    script = _gate_script()
    env = dict(os.environ)
    env.pop("FLOW_READY", None)
    if not unset:
        env["FLOW_READY"] = "" if flow_ready is None else flow_ready
    proc = subprocess.run(
        ["bash", "-e", _script_file(script)],
        env=env,
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


class TheGateExistsAndRunsFirst(unittest.TestCase):
    """Two assertions about position, because neither is sufficient alone:
    an explicit allowlist of what may precede the gate, not a blanket
    "anything may precede it as long as it precedes one named step further
    down" — the weaker reading a `gh repo create` inserted at the top of the
    job once satisfied. See test_provision_tenant_flow_gate.md#thegateexistsandrunsfirst."""

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

    def test_nothing_unvetted_runs_before_the_gate(self):
        """The stronger half of "it runs first", and the one the ordering
        assertion below cannot give.

        "The gate precedes FIRST_MUTATING_STEP_NAME" is satisfied by a new
        step inserted at the very top of the job, because that step is above
        the named one too. So the steps allowed to precede the gate are
        enumerated instead, and the list is empty."""
        names = _step_names(_steps_block(_read_workflow()))
        before = names[:names.index(GATE_STEP_NAME)]
        self.assertEqual(
            [n for n in before if n not in STEPS_ALLOWED_BEFORE_THE_GATE], [],
            "steps run before the gate that are not in "
            "STEPS_ALLOWED_BEFORE_THE_GATE. A step above the gate runs "
            "whatever the repository variable says; add it to that list "
            "only after reading it and concluding it creates nothing")

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

    def test_no_later_step_survives_the_gates_refusal(self):
        """The same two keys, one step down, where they are worse.

        A clean gate step is not enough. `if: always()` on `Generate the
        tenant repo from the template` leaves the gate byte-identical, lets
        it refuse, lets the job go red -- and creates the tenant repository
        anyway, using job-level env that needs no checkout. A red run that
        created a repository is worse than either a red run or a green one,
        because nobody goes looking for state after a failure."""
        offenders = {
            name: sorted(keys & {"if", "continue-on-error"})
            for name, keys
            in _step_keys_by_name(_steps_block(_read_workflow())).items()
            if keys & {"if", "continue-on-error"}
            and name not in STEPS_ALLOWED_TO_SURVIVE_A_FAILED_PREDECESSOR
        }
        self.assertEqual(
            offenders, {},
            "these steps carry a key that lets them run, or survive, after "
            "the gate has refused. Every step in this job is conditional on "
            "its predecessors succeeding by default, and that default is "
            "what makes the gate's exit 1 stop anything. Add a name to "
            "STEPS_ALLOWED_TO_SURVIVE_A_FAILED_PREDECESSOR only for a step "
            "that creates nothing")

    def test_no_defaults_block_can_replace_the_shell_that_runs_the_gate(self):
        """`defaults: run: shell:` at workflow or job level substitutes the
        command every `run:` block is handed to, the gate's included, and
        could neutralise every step while leaving its text untouched, so the
        assertion is conservative: no `defaults:` at all.
        See test_provision_tenant_flow_gate.md#test_no_defaults_block_can_replace_the_shell_that_runs_the_gate."""
        workflow = _read_workflow()
        self.assertIsNone(
            re.search(r"^defaults:", workflow, re.MULTILINE),
            "the workflow declares a top-level 'defaults:' block, which can "
            "carry a run.shell that replaces the interpreter for the gate")
        self.assertIsNone(
            re.search(r"^    defaults:", _job_block(workflow, GATE_JOB_NAME),
                      re.MULTILINE),
            f"the {GATE_JOB_NAME!r} job declares a 'defaults:' block, which "
            "can carry a run.shell that replaces the interpreter for the "
            "gate")


if __name__ == "__main__":
    unittest.main()
