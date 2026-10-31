"""Truth table for check_private_tenant_plan.py, the gate that is the only reader
of registers/private-tenant-plan.json. Exit 0 passes, exit 1 refuses on a
missing attestation, exit 2 fails closed on a register that cannot be read as a
valid plan. Also checks the CODEOWNERS line that gives the register its
owner-only review, and that the SYNC-1 tail block is still last.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parent
REPO = SCRIPTS.parents[2]
GATE = SCRIPTS / "check_private_tenant_plan.py"
SHIPPED_REGISTER = REPO / "registers" / "private-tenant-plan.json"
CODEOWNERS = REPO / ".github" / "CODEOWNERS"

GOOD_LABEL = "private-ci-hetzner"
REGISTER_PATTERN = "/registers/private-tenant-plan.*"
OWNER = "@branchLeft/branchleft-admin"
SYNC_TAIL = [
    "/.standardsignore",
    "/.standards.mode",
    "/.docs-lint*",
    "/tools/floors.tsv",
    "/.standards-db-tooling",
    "/.github/",
]


def _register(paid=True, runner=True, label=GOOD_LABEL, version=1):
    return {
        "version": version,
        "paid_plan_confirmed": paid,
        "dedicated_runner_confirmed": runner,
        "dedicated_runner_label": label,
    }


class GateCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="plan-gate-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _write(self, text):
        path = os.path.join(self.tmp, "private-tenant-plan.json")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def _gate_on_text(self, text):
        return self._run(self._write(text))

    def _gate_on(self, data):
        return self._gate_on_text(json.dumps(data))

    def _run(self, path):
        proc = subprocess.run(
            [sys.executable, str(GATE), "--register", path],
            capture_output=True,
            text=True,
        )
        return proc.returncode, proc.stdout + proc.stderr

    def _errors(self, out):
        return [line for line in out.splitlines() if line.startswith("::error::")]


class ARefusalOnAMissingAttestation(GateCase):
    def test_neither_attested_refuses_and_names_both(self):
        rc, out = self._gate_on(_register(paid=False, runner=False))
        self.assertEqual(rc, 1, out)
        self.assertEqual(len(self._errors(out)), 2, out)
        self.assertIn("paid_plan_confirmed is false", out)
        self.assertIn("dedicated_runner_confirmed is false", out)
        self.assertIn("owner's spend", out)
        self.assertIn("Mac", out)

    def test_only_the_runner_missing_names_only_the_runner(self):
        rc, out = self._gate_on(_register(paid=True, runner=False))
        self.assertEqual(rc, 1, out)
        self.assertEqual(len(self._errors(out)), 1, out)
        self.assertIn("dedicated_runner_confirmed is false", out)
        self.assertNotIn("paid_plan_confirmed is false", out)
        self.assertIn("owner's spend", out)
        self.assertIn("Mac", out)

    def test_only_the_plan_missing_names_only_the_plan(self):
        rc, out = self._gate_on(_register(paid=False, runner=True))
        self.assertEqual(rc, 1, out)
        self.assertEqual(len(self._errors(out)), 1, out)
        self.assertIn("paid_plan_confirmed is false", out)
        self.assertNotIn("dedicated_runner_confirmed is false", out)
        self.assertIn("owner's spend", out)
        self.assertIn("Mac", out)

    def test_a_runner_label_that_is_not_hetzner_refuses(self):
        rc, out = self._gate_on(_register(label="github-hosted"))
        self.assertEqual(rc, 1, out)
        self.assertEqual(len(self._errors(out)), 1, out)
        self.assertIn("dedicated_runner_label does not start with", out)
        self.assertIn("Mac", out)
        self.assertIn("owner's spend", out)

    def test_a_personal_mac_label_refuses(self):
        rc, out = self._gate_on(_register(label="mac-mini-owner"))
        self.assertEqual(rc, 1, out)
        self.assertIn("dedicated_runner_label does not start with", out)


class BothAttestedPasses(GateCase):
    def test_both_true_with_the_hetzner_label_exits_zero(self):
        rc, out = self._gate_on(_register())
        self.assertEqual(rc, 0, out)
        self.assertEqual(self._errors(out), [], out)

    def test_a_longer_hetzner_label_still_passes(self):
        rc, out = self._gate_on(_register(label="private-ci-hetzner-fsn1"))
        self.assertEqual(rc, 0, out)


class TheAttestationIsLiteralJsonTrue(GateCase):
    def test_non_boolean_attestations_fail_closed_with_exit_two(self):
        for value in ("true", "True", 1, 0, None, [True]):
            for field in ("paid_plan_confirmed", "dedicated_runner_confirmed"):
                with self.subTest(field=field, value=value):
                    data = _register()
                    data[field] = value
                    rc, out = self._gate_on(data)
                    self.assertEqual(rc, 2, out)
                    self.assertIn("::error::", out)
                    self.assertIn("literal JSON true or false", out)

    def test_a_missing_attestation_fails_closed_with_exit_two(self):
        for field in ("paid_plan_confirmed", "dedicated_runner_confirmed"):
            with self.subTest(field=field):
                data = _register()
                del data[field]
                rc, out = self._gate_on(data)
                self.assertEqual(rc, 2, out)
                self.assertIn("::error::", out)


class TheRegisterMustReadCleanly(GateCase):
    def test_a_missing_label_fails_closed_with_exit_two(self):
        data = _register()
        del data["dedicated_runner_label"]
        rc, out = self._gate_on(data)
        self.assertEqual(rc, 2, out)
        self.assertIn("fields are wrong", out)

    def test_a_non_string_label_fails_closed_with_exit_two(self):
        rc, out = self._gate_on(_register(label=5))
        self.assertEqual(rc, 2, out)
        self.assertIn("dedicated_runner_label must be a string", out)

    def test_an_unknown_field_fails_closed_with_exit_two(self):
        data = _register()
        data["dedicated_runner_confirmd"] = True
        rc, out = self._gate_on(data)
        self.assertEqual(rc, 2, out)

    def test_a_duplicate_key_fails_closed_with_exit_two(self):
        text = (
            '{"version": 1, "paid_plan_confirmed": false, '
            '"paid_plan_confirmed": true, "dedicated_runner_confirmed": true, '
            '"dedicated_runner_label": "private-ci-hetzner"}'
        )
        rc, out = self._gate_on_text(text)
        self.assertEqual(rc, 2, out)
        self.assertIn("repeats the key 'paid_plan_confirmed'", out)

    def test_the_wrong_version_fails_closed_with_exit_two(self):
        for version in (2, "1", 1.0, True):
            with self.subTest(version=version):
                rc, out = self._gate_on(_register(version=version))
                self.assertEqual(rc, 2, out)
                self.assertIn("version must be 1", out)

    def test_invalid_json_fails_closed_with_exit_two(self):
        rc, out = self._gate_on_text('{"version": 1,')
        self.assertEqual(rc, 2, out)
        self.assertIn("not valid JSON", out)

    def test_a_top_level_list_fails_closed_with_exit_two(self):
        rc, out = self._gate_on_text("[]")
        self.assertEqual(rc, 2, out)
        self.assertIn("not a JSON object", out)

    def test_a_missing_file_fails_closed_with_exit_two(self):
        rc, out = self._run(os.path.join(self.tmp, "absent.json"))
        self.assertEqual(rc, 2, out)
        self.assertIn("missing", out)


class TheCommittedRegisterParses(unittest.TestCase):
    def test_the_shipped_register_exits_zero_or_one_never_two(self):
        self.assertTrue(SHIPPED_REGISTER.is_file(), str(SHIPPED_REGISTER))
        proc = subprocess.run(
            [sys.executable, str(GATE), "--register", str(SHIPPED_REGISTER)],
            capture_output=True,
            text=True,
        )
        self.assertIn(proc.returncode, (0, 1), proc.stdout + proc.stderr)


class TheOwnerOnlyRegisterIsCodeOwned(unittest.TestCase):
    def _lines(self):
        return [line.strip() for line in CODEOWNERS.read_text(encoding="utf-8").splitlines()]

    def test_the_register_is_owned_by_the_admin_team(self):
        matches = [
            line
            for line in self._lines()
            if line.split() and line.split()[0] == REGISTER_PATTERN
        ]
        self.assertEqual(len(matches), 1, matches)
        self.assertEqual(matches[0].split()[1:], [OWNER])

    def test_the_sync_tail_block_is_still_the_last_six_lines(self):
        content = [line for line in self._lines() if line and not line.startswith("#")]
        tail = [line.split()[0] for line in content[-len(SYNC_TAIL):]]
        self.assertEqual(tail, SYNC_TAIL)

    def test_the_register_line_sits_above_the_sync_tail(self):
        content = [line.split()[0] for line in self._lines() if line and not line.startswith("#")]
        self.assertLess(content.index(REGISTER_PATTERN), content.index(SYNC_TAIL[0]))


if __name__ == "__main__":
    unittest.main()
