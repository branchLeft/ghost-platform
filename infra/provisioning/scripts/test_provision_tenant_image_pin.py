#!/usr/bin/env python3
"""Tests for the image-pin step in provision-tenant.yml.

The generated tenant repository reads the image it runs from `image-pin.txt`
at its root (its `config.ts`, `scripts/image-changed.py` and the deploy job's
read step), and from nowhere else. So provisioning must (a) write that file
from the attested `image_ref`, in the one shape those readers accept, (b) put
it in the handover commit, and (c) stop setting the Pulumi config key
`imageRef`, which nothing reads any more.

Structure is read with the flow-gate helpers; the step's shell is run, not
pattern-matched.
"""

from __future__ import annotations

import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import test_provision_tenant_flow_gate as gate  # noqa: E402

STEP_NAME = "Write the tenant's image pin"
INIT_STEP_NAME = "Initialise the tenant stack and write its non-secret config"
SALT_REMOVAL_STEP_NAME = (
    "Remove the encryption salt before the stack config is committed")
HANDOVER_STEP_NAME = "Open the handover pull request"
PIN_FILE = "image-pin.txt"

DIGEST = "a" * 64
GOOD_REF = "ghcr.io/branchleft/ghost-tenant@sha256:" + DIGEST

# The shape the tenant repository's deploy read step accepts, verbatim from
# its workflow. A ref this refuses would make the tenant's first deploy
# refuse, after the whole tenant had been provisioned.
READER_PATTERN = re.compile(
    r"\A[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}\Z")


def _steps():
    return gate._steps_block(gate._read_workflow())


def _body():
    return gate._step_body(_steps(), STEP_NAME)


def _script():
    return gate._run_script(_body())


def _run(script: str, image_ref: str | None) -> tuple[int, str, bytes | None]:
    """Run `script` as `bash -e` (a `run:` block with no `shell:` on Linux)
    in an empty directory. Returns (rc, output, the pin file's bytes or None)."""
    with tempfile.TemporaryDirectory(prefix="image-pin-") as work:
        script_path = os.path.join(work, "step.sh")
        tenant = os.path.join(work, "tenant")
        os.mkdir(tenant)
        with open(script_path, "w", encoding="utf-8") as fh:
            fh.write(script)
        env = dict(os.environ)
        env.pop("IMAGE_REF", None)
        if image_ref is not None:
            env["IMAGE_REF"] = image_ref
        proc = subprocess.run(
            ["bash", "-e", script_path], cwd=tenant, env=env,
            capture_output=True, text=True, check=False)
        pin = pathlib.Path(tenant, PIN_FILE)
        return (proc.returncode, proc.stdout + proc.stderr,
                pin.read_bytes() if pin.exists() else None)


class StepPresenceAndOrderingTests(unittest.TestCase):
    def setUp(self):
        self.steps = _steps()
        self.names = gate._step_names(self.steps)

    def test_the_step_exists(self):
        self.assertIn(STEP_NAME, self.names)

    def test_it_runs_after_the_repository_is_created(self):
        self.assertGreater(self.names.index(STEP_NAME),
                           self.names.index(gate.FIRST_MUTATING_STEP_NAME))

    def test_it_runs_before_the_salt_guard_scans_the_tree(self):
        self.assertLess(self.names.index(STEP_NAME),
                        self.names.index(SALT_REMOVAL_STEP_NAME))

    def test_it_runs_before_the_handover_commit(self):
        self.assertLess(self.names.index(STEP_NAME),
                        self.names.index(HANDOVER_STEP_NAME))

    def test_it_works_in_the_tenant_checkout_and_cannot_be_skipped(self):
        body = _body()
        self.assertIn("        working-directory: tenant\n", body)
        self.assertEqual(gate._step_keys(body) - {"working-directory", "run"},
                         set())

    def test_the_handover_commit_stages_everything_in_that_checkout(self):
        body = gate._step_body(self.steps, HANDOVER_STEP_NAME)
        self.assertIn("        working-directory: tenant\n", body)
        self.assertIn("git add -A", gate._run_script(body))

    def test_it_reads_the_job_level_image_ref_and_no_other_source(self):
        workflow = gate._read_workflow()
        self.assertIn("      IMAGE_REF: ${{ inputs.image_ref }}\n", workflow)
        self.assertNotIn("${{", _script())


class NothingSetsImageRefConfigAnyMoreTests(unittest.TestCase):
    def test_no_step_sets_the_pulumi_config_key(self):
        workflow = gate._read_workflow()
        code = "\n".join(line for line in workflow.splitlines()
                         if not line.lstrip().startswith("#"))
        self.assertNotRegex(code, r"config set imageRef")
        self.assertNotRegex(code, r"config set --path imageRef")

    def test_the_init_step_still_sets_the_other_non_secret_config(self):
        body = gate._run_script(gate._step_body(_steps(), INIT_STEP_NAME))
        for key in ("slug", "siteUrl", "uid", "hostPort", "appHostPrivateIp",
                    "databaseHost", "mediaEndpoint", "mediaRegion"):
            self.assertIn("pulumi config set %s " % key, body)


class WrittenFileTests(unittest.TestCase):
    def test_it_writes_exactly_the_ref_and_one_newline(self):
        rc, out, pin = _run(_script(), GOOD_REF)
        self.assertEqual(rc, 0, out)
        self.assertEqual(pin, (GOOD_REF + "\n").encode())

    def test_what_it_writes_is_what_the_tenant_reader_accepts(self):
        _, _, pin = _run(_script(), GOOD_REF)
        assert pin is not None
        lines = pin.decode().split("\n")
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[1], "")
        self.assertRegex(lines[0], READER_PATTERN)

    def test_a_nested_image_path_is_written_whole(self):
        ref = "ghcr.io/branchleft/team/ghost-tenant@sha256:" + DIGEST
        rc, out, pin = _run(_script(), ref)
        self.assertEqual(rc, 0, out)
        self.assertEqual(pin, (ref + "\n").encode())


BAD_REFS = {
    "empty": "",
    "tag only": "ghcr.io/branchleft/ghost-tenant:latest",
    "short digest": "ghcr.io/branchleft/ghost-tenant@sha256:" + "a" * 63,
    "uppercase digest": "ghcr.io/branchleft/ghost-tenant@sha256:" + "A" * 64,
    "trailing newline then more": GOOD_REF + "\nEXTRA=1",
    "leading newline": "\n" + GOOD_REF,
    "trailing newline": GOOD_REF + "\n",
    "embedded space": "ghcr.io/branchleft/ghost tenant@sha256:" + DIGEST,
    "quoted": "'" + GOOD_REF + "'",
    "comment": "# " + GOOD_REF,
}


class RefusalTests(unittest.TestCase):
    def test_each_malformed_ref_is_refused_and_writes_nothing(self):
        for label, ref in BAD_REFS.items():
            with self.subTest(label):
                rc, out, pin = _run(_script(), ref)
                self.assertNotEqual(rc, 0, out)
                self.assertIsNone(pin, "a refused ref left a pin file behind")

    def test_an_unset_ref_is_refused(self):
        rc, out, pin = _run(_script(), None)
        self.assertNotEqual(rc, 0, out)
        self.assertIsNone(pin)

    def test_the_refusal_does_not_echo_the_ref(self):
        marker = "ghcr.io/branchleft/leak-canary:tag"
        _, out, _ = _run(_script(), marker)
        self.assertNotIn(marker, out)


class SabotageTests(unittest.TestCase):
    """The refusal tests are only worth something if they can fail. Strip the
    shape check from the real script and the same inputs must get through."""

    @staticmethod
    def _without_the_shape_check(script: str) -> str:
        stripped = re.sub(r"if ! \[\[.*?\nfi\n", "", script, flags=re.DOTALL)
        assert stripped != script, "the shape check was not found to strip"
        return stripped

    def test_without_the_check_a_malformed_ref_is_written(self):
        sabotaged = self._without_the_shape_check(_script())
        rc, _, pin = _run(sabotaged, "ghcr.io/branchleft/ghost-tenant:latest")
        self.assertEqual(rc, 0)
        self.assertIsNotNone(pin)

    def test_without_the_check_the_refusal_tests_would_fail(self):
        sabotaged = self._without_the_shape_check(_script())
        survivors = [label for label, ref in BAD_REFS.items()
                     if _run(sabotaged, ref)[0] == 0]
        self.assertTrue(survivors, "no malformed ref got past a stripped check")


if __name__ == "__main__":
    unittest.main()
