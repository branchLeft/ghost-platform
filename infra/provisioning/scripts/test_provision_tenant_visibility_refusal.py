"""Tests for the tenant_visibility gate in ../../../.github/workflows/
provision-tenant.yml. A private tenant passes only when the owner's plan register
attests a paid plan and a dedicated runner, via check_private_tenant_plan.py.
The gate runs in Validate inputs, before any credential or repository step, and
again at repository creation. Each case block runs under bash -e against a
temporary workspace with a fixture register. A sabotage test removes the gate
call in memory and shows the refusal depends on it.
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parent
WORKFLOW = SCRIPTS.parents[2] / ".github" / "workflows" / "provision-tenant.yml"
GATE_SOURCE = SCRIPTS / "check_private_tenant_plan.py"
GATE_RELPATH = "infra/provisioning/scripts/check_private_tenant_plan.py"
REGISTER_RELPATH = "registers/private-tenant-plan.json"

VALIDATE_STEP = "Validate inputs"
CREATE_STEP = "Generate the tenant repo from the template"

# Steps that create a repository or write a credential, in the order the
# job runs them. The validation step must precede every one of them.
MUTATING_STEPS = (
    "Generate the tenant repo from the template",
    "Clone and generate",
    "Mint, escrow and publish this tenant's secrets passphrase",
    "Protect the generated repository's default branch",
    "Write the tenant repo's state credentials and variables",
    "Open the handover pull request",
    "Upload the escrowed ciphertext",
    "Initialise the tenant stack and write its non-secret config",
    "Publish this tenant's encryption salt to its own environment secret",
)

GATE_CALL = (
    'python3 "$GITHUB_WORKSPACE/infra/provisioning/scripts/'
    'check_private_tenant_plan.py" || exit 1'
)

STEP_LINE = re.compile(r"^      - name: (.+)$")
JOB_KEY_LINE = re.compile(r"^  [A-Za-z_][A-Za-z0-9_-]*:")


def register_json(paid, runner, label="private-ci-hetzner"):
    return json.dumps(
        {
            "version": 1,
            "paid_plan_confirmed": paid,
            "dedicated_runner_confirmed": runner,
            "dedicated_runner_label": label,
        }
    )


NEITHER = register_json(False, False)
BOTH = register_json(True, True)


def _read_workflow():
    with open(WORKFLOW, encoding="utf-8") as fh:
        return fh.read().splitlines()


def _step_names(lines):
    return [m.group(1) for m in (STEP_LINE.match(line) for line in lines) if m]


def _step_lines(lines, name):
    """The lines of one step, from its `- name:` line up to the next step
    or the next job-level key."""
    start = None
    for i, line in enumerate(lines):
        m = STEP_LINE.match(line)
        if m and m.group(1) == name:
            start = i
            break
    if start is None:
        raise AssertionError(f"step {name!r} not found in {WORKFLOW}")
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if STEP_LINE.match(lines[j]) or JOB_KEY_LINE.match(lines[j]):
            end = j
            break
    return lines[start:end]


def _run_body(step):
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


def _visibility_case(body):
    """The first `case "$TENANT_VISIBILITY" ... esac` block of a step body."""
    start = None
    for i, line in enumerate(body):
        if line.startswith('case "$TENANT_VISIBILITY" in'):
            start = i
            break
    if start is None:
        raise AssertionError("no visibility case block in the step")
    for j in range(start, len(body)):
        if body[j] == "esac":
            return body[start : j + 1]
    raise AssertionError("visibility case block has no closing esac")


def _visibility_block(step=VALIDATE_STEP, lines=None):
    lines = _read_workflow() if lines is None else lines
    return _visibility_case(_run_body(_step_lines(lines, step)))


def _make_workspace(register):
    """A temporary GITHUB_WORKSPACE holding a copy of the real gate script,
    and the given register text (or no register at all when None)."""
    root = tempfile.mkdtemp(prefix="visibility-workspace-")
    scripts = os.path.join(root, "infra", "provisioning", "scripts")
    os.makedirs(scripts)
    shutil.copy2(GATE_SOURCE, os.path.join(scripts, "check_private_tenant_plan.py"))
    if register is not None:
        os.makedirs(os.path.join(root, "registers"))
        with open(os.path.join(root, REGISTER_RELPATH), "w", encoding="utf-8") as fh:
            fh.write(register)
    return root


def _run_block(block, visibility, register, print_after=""):
    """Execute a visibility case block with TENANT_VISIBILITY set to
    `visibility`, then `print_after` if given. Returns (returncode, output)."""
    workspace = _make_workspace(register)
    try:
        script = 'fail() { echo "::error::$1"; exit 1; }\n' + "\n".join(block) + "\n"
        if print_after:
            script += print_after + "\n"
        path = os.path.join(workspace, "check.sh")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(script)
        env = dict(os.environ)
        env["TENANT_VISIBILITY"] = visibility
        env["GITHUB_WORKSPACE"] = workspace
        proc = subprocess.run(
            ["bash", "-e", path], env=env, capture_output=True, text=True
        )
        return proc.returncode, proc.stdout + proc.stderr
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def _run_visibility(
    visibility, step=VALIDATE_STEP, print_after="", register=NEITHER, lines=None
):
    return _run_block(
        _visibility_block(step, lines), visibility, register, print_after
    )


class APrivateTenantNeedsBothAttestations(unittest.TestCase):
    def test_private_with_neither_attestation_is_refused_and_names_both(self):
        rc, out = _run_visibility("private", register=NEITHER)
        self.assertNotEqual(rc, 0, out)
        self.assertIn("::error::paid_plan_confirmed is false", out)
        self.assertIn("::error::dedicated_runner_confirmed is false", out)
        self.assertIn("owner's spend", out)
        self.assertIn("Mac", out)

    def test_each_combination_of_the_two_attestations(self):
        cases = (
            (False, False, False),
            (True, False, False),
            (False, True, False),
            (True, True, True),
        )
        for paid, runner, passes in cases:
            with self.subTest(paid=paid, runner=runner):
                rc, out = _run_visibility(
                    "private", register=register_json(paid, runner)
                )
                if passes:
                    self.assertEqual(rc, 0, out)
                    self.assertNotIn("::error::", out)
                else:
                    self.assertNotEqual(rc, 0, out)
                    self.assertIn("::error::", out)

    def test_private_with_both_attested_passes_the_validation_step(self):
        rc, out = _run_visibility("private", register=BOTH)
        self.assertEqual(rc, 0, out)
        self.assertNotIn("::error::", out)

    def test_other_spellings_are_refused_even_with_both_attested(self):
        for value in (
            "Private",
            "PRIVATE",
            "pRiVaTe",
            " private",
            "private ",
            "Public",
            "PUBLIC",
            "",
        ):
            with self.subTest(value=value):
                rc, out = _run_visibility(value, register=BOTH)
                self.assertNotEqual(rc, 0, out)
                self.assertIn("::error::", out)

    def test_the_validation_arm_calls_the_gate_and_stops_on_failure(self):
        block = "\n".join(_visibility_block())
        self.assertIn(GATE_CALL, block)


class APublicTenantStillPasses(unittest.TestCase):
    def test_public_passes_without_error(self):
        rc, out = _run_visibility("public")
        self.assertEqual(rc, 0, out)
        self.assertNotIn("::error::", out)

    def test_public_never_reads_the_register(self):
        rc, out = _run_visibility("public", register=None)
        self.assertEqual(rc, 0, out)
        self.assertNotIn("private-tenant plan", out)

    def test_an_unanswered_choice_is_still_refused(self):
        rc, out = _run_visibility("ask the tenant -- this is not an answer")
        self.assertNotEqual(rc, 0, out)
        self.assertIn("tenant_visibility was not answered", out)


class TheRepositoryCreationStepGatesPrivateAgain(unittest.TestCase):
    def test_private_on_an_unconfirmed_register_is_refused_with_no_flag(self):
        rc, out = _run_visibility(
            "private",
            step=CREATE_STEP,
            print_after='echo "$visibility_flag"',
            register=NEITHER,
        )
        self.assertNotEqual(rc, 0, out)
        self.assertNotIn("--private", out)

    def test_private_on_a_confirmed_register_gets_the_private_flag(self):
        rc, out = _run_visibility(
            "private",
            step=CREATE_STEP,
            print_after='echo "$visibility_flag"',
            register=BOTH,
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.strip().splitlines()[-1], "--private")

    def test_public_still_picks_public(self):
        rc, out = _run_visibility(
            "public",
            step=CREATE_STEP,
            print_after='echo "$visibility_flag"',
            register=None,
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.strip(), "--public")

    def test_other_spellings_get_no_flag_even_with_both_attested(self):
        for value in ("Private", "PRIVATE", ""):
            with self.subTest(value=value):
                rc, out = _run_visibility(
                    value,
                    step=CREATE_STEP,
                    print_after='echo "$visibility_flag"',
                    register=BOTH,
                )
                self.assertNotEqual(rc, 0, out)
                self.assertNotIn("--private", out)


class TheRefusalPrecedesEveryMutation(unittest.TestCase):
    def test_validation_runs_before_any_repository_or_credential_step(self):
        names = _step_names(_read_workflow())
        self.assertIn(VALIDATE_STEP, names)
        validate_at = names.index(VALIDATE_STEP)
        for step in MUTATING_STEPS:
            with self.subTest(step=step):
                self.assertIn(
                    step, names, f"{step!r} no longer exists; update this list"
                )
                self.assertLess(
                    validate_at,
                    names.index(step),
                    f"{VALIDATE_STEP!r} must run before {step!r}",
                )


class SabotageTests(unittest.TestCase):
    """Red, then green, for the validation gate. The gate call in the Validate
    step's private arm is replaced, in memory, by a no-op. The replacement
    count is asserted to be exactly one. With the mechanism broken, a private
    tenant on an unconfirmed register gets through (red). With the real
    workflow it is refused (green)."""

    def test_removing_the_gate_call_lets_private_through_and_the_real_workflow_refuses_it(self):
        validate = _step_lines(_read_workflow(), VALIDATE_STEP)
        broken_text, replaced = re.subn(
            r'^([ \t]+)' + re.escape(GATE_CALL) + r"$",
            r"\1true",
            "\n".join(validate),
            flags=re.M,
        )
        self.assertEqual(replaced, 1, "the gate call is not in the Validate step once")
        broken = broken_text.split("\n")

        red_rc, red_out = _run_block(
            _visibility_block(VALIDATE_STEP, broken), "private", NEITHER
        )
        self.assertEqual(red_rc, 0, "the broken workflow should admit private: " + red_out)

        green_rc, green_out = _run_visibility("private", register=NEITHER)
        self.assertNotEqual(green_rc, 0, green_out)
        self.assertIn("::error::paid_plan_confirmed is false", green_out)


if __name__ == "__main__":
    unittest.main()
