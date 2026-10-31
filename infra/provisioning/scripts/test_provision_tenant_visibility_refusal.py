"""Tests for the visibility refusal in ../../../.github/workflows/
provision-tenant.yml. A private tenant is refused by the 'Validate inputs'
step, before any step that writes a credential or creates a repository, so
the tenant's state credentials are never handed to a private repository's
production environment by this workflow.

The refusal is tested by extracting the visibility `case` block from the
step's `run:` body and executing it under `bash -e`, not by matching YAML
text. A separate test reads the step order from the workflow file.
"""

import os
import pathlib
import re
import subprocess
import tempfile
import unittest

WORKFLOW = (
    pathlib.Path(__file__).resolve().parents[3]
    / ".github"
    / "workflows"
    / "provision-tenant.yml"
)

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

STEP_LINE = re.compile(r"^      - name: (.+)$")
JOB_KEY_LINE = re.compile(r"^  [A-Za-z_][A-Za-z0-9_-]*:")


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


def _run_visibility(visibility, step=VALIDATE_STEP, print_after=""):
    """Execute the visibility case block of `step` with TENANT_VISIBILITY set
    to `visibility`, then run `print_after` if given. Returns (returncode,
    combined output)."""
    block = _visibility_case(_run_body(_step_lines(_read_workflow(), step)))
    script = 'fail() { echo "::error::$1"; exit 1; }\n' + "\n".join(block) + "\n"
    if print_after:
        script += print_after + "\n"
    directory = tempfile.mkdtemp(prefix="visibility-refusal-")
    path = os.path.join(directory, "check.sh")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(script)
    env = dict(os.environ)
    env["TENANT_VISIBILITY"] = visibility
    proc = subprocess.run(
        ["bash", "-e", path], env=env, capture_output=True, text=True
    )
    return proc.returncode, proc.stdout + proc.stderr


class APrivateTenantIsRefused(unittest.TestCase):
    def test_private_is_refused_with_the_named_alternative(self):
        rc, out = _run_visibility("private")
        self.assertNotEqual(rc, 0, out)
        self.assertIn("::error::", out)
        self.assertIn("refused by this public provisioning workflow", out)
        self.assertIn("the owner's to run", out)
        self.assertIn("No agent or hand run", out)

    def test_other_spellings_of_private_are_refused(self):
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
                rc, out = _run_visibility(value)
                self.assertNotEqual(rc, 0, out)
                self.assertIn("::error::", out)


class APublicTenantStillPasses(unittest.TestCase):
    def test_public_passes_without_error(self):
        rc, out = _run_visibility("public")
        self.assertEqual(rc, 0, out)
        self.assertNotIn("::error::", out)

    def test_an_unanswered_choice_is_still_refused(self):
        rc, out = _run_visibility("ask the tenant -- this is not an answer")
        self.assertNotEqual(rc, 0, out)
        self.assertIn("tenant_visibility was not answered", out)


class TheRepositoryCreationStepHasNoPrivateArm(unittest.TestCase):
    def test_creation_case_refuses_private_and_every_other_spelling(self):
        for value in ("private", "Private", "PRIVATE", ""):
            with self.subTest(value=value):
                rc, out = _run_visibility(
                    value, CREATE_STEP, print_after='echo "$visibility_flag"'
                )
                self.assertNotEqual(rc, 0, out)
                self.assertNotIn("--private", out)

    def test_creation_case_still_picks_public(self):
        rc, out = _run_visibility(
            "public", CREATE_STEP, print_after='echo "$visibility_flag"'
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.strip(), "--public")


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


INPUT_KEY_LINE = re.compile(r"^      [A-Za-z_][A-Za-z0-9_]*:")


def _visibility_options(lines):
    """The option values of the `tenant_visibility` dispatch input, as the
    form would offer them."""
    start = lines.index("      tenant_visibility:")
    options = []
    for line in lines[start + 1 :]:
        if INPUT_KEY_LINE.match(line):
            break
        stripped = line.strip()
        if stripped.startswith("- "):
            options.append(stripped[2:].strip().strip("'"))
    return options


class TheDispatchFormOffersNoPrivateOption(unittest.TestCase):
    def test_the_visibility_choice_offers_public_and_no_private(self):
        options = _visibility_options(_read_workflow())
        self.assertIn("public", options)
        self.assertNotIn(
            "private",
            [option.lower() for option in options],
            "the dispatch form must not offer private: the workflow refuses it",
        )


PRIVATE_BRANCH = re.compile(r'TENANT_VISIBILITY"\s*==?\s*"private"', re.IGNORECASE)


class TheWorkflowBranchesOnPrivateNowhere(unittest.TestCase):
    def test_no_step_has_a_private_arm_that_could_proceed(self):
        offenders = [
            f"line {i}: {line.strip()}"
            for i, line in enumerate(_read_workflow(), start=1)
            if PRIVATE_BRANCH.search(line)
        ]
        self.assertEqual(
            offenders,
            [],
            "a step branches on a private visibility; the validation refusal "
            "is the only private path, so no step may treat private as handled",
        )


if __name__ == "__main__":
    unittest.main()
