#!/usr/bin/env python3
"""Unit tests for render_tenant_secrets.

The host-side half of "a tenant stack holds no secret value": the script that
turns the stack's key-name template and values on stdin into a root-owned
0600 file. See test_render_tenant_secrets.md for the coverage rationale.

Everything runs in a temporary directory, as the calling user. Ownership is
asserted through an injected chown, plus a real stat when the suite runs as root.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import stat
import tempfile
import types
import unittest
from unittest import mock

import render_tenant_secrets as rts

TEMPLATE = (
    "# Secrets for the alpha Ghost stack, at /etc/branchleft/alpha.env.\n"
    "# Root-owned, mode 0600.\n"
    "GHOST_DB_PASSWORD=\n"
    "GHOST_MAIL_PASSWORD=\n"
    "GHOST_OWNER_EMAIL=\n"
)

# Sentinels no template, comment or error message could contain by accident.
DB = "sentinel-db-4c1e7a90"
MAIL = "sentinel-mail-7f41ad23"
OWNER = "sentinel-owner-9b63cf45@sentinel-owner.example.test"
VALUES = {"GHOST_DB_PASSWORD": DB, "GHOST_MAIL_PASSWORD": MAIL, "GHOST_OWNER_EMAIL": OWNER}
SENTINELS = (DB, MAIL, OWNER, "sentinel-owner-9b63cf45")


class Chown:
    """Stands in for `os.fchown`: records the call, changes nothing."""

    def __init__(self):
        self.calls: list[tuple[int, int]] = []

    def __call__(self, fd, uid, gid):
        self.calls.append((uid, gid))


def assert_secure_file(test: unittest.TestCase, path: str, chown: Chown | None = None) -> None:
    """The properties the story asks of the rendered file."""
    info = os.lstat(path)
    test.assertTrue(stat.S_ISREG(info.st_mode), "not a regular file")
    test.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
    if chown is not None:
        test.assertEqual(chown.calls and chown.calls[0], (0, 0))
    if os.geteuid() == 0:
        test.assertEqual((info.st_uid, info.st_gid), (0, 0))


class Host(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.etc = os.path.join(self._dir.name, "etc-branchleft")
        os.makedirs(self.etc)
        self.template_file = os.path.join(self._dir.name, "template.env")
        with open(self.template_file, "w", encoding="utf-8") as handle:
            handle.write(TEMPLATE)
        self.chown = Chown()
        self.target = os.path.join(self.etc, "alpha.env")

    def run_main(self, values, *, slug="alpha", raw=None, geteuid=lambda: 0, module=rts, **extra):
        stdin = io.StringIO(json.dumps(values) if raw is None else raw)
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = module.main(
                [f"--slug={slug}", "--template-file", self.template_file, "--etc-dir", self.etc],
                geteuid=geteuid,
                stdin=stdin,
                fchown=extra.pop("fchown", self.chown),
                **extra,
            )
        return code, stdout.getvalue(), stderr.getvalue()

    def assert_no_sentinel(self, *texts):
        for text in texts:
            for sentinel in SENTINELS:
                self.assertNotIn(sentinel, text)

    def assert_nothing_left(self):
        self.assertEqual(os.listdir(self.etc), [], "a file or temp file was left behind")

    def refused(self, values=None, **kwargs):
        code, out, err = self.run_main(VALUES if values is None else values, **kwargs)
        self.assertEqual(code, 1, err)
        self.assert_no_sentinel(out, err)
        return err


class Rendering(Host):
    def test_writes_the_filled_template_mode_0600_owned_root(self):
        code, out, err = self.run_main(VALUES)
        self.assertEqual(code, 0, err)
        with open(self.target, encoding="utf-8") as handle:
            written = handle.read()
        self.assertEqual(
            written,
            TEMPLATE.replace("GHOST_DB_PASSWORD=", f"GHOST_DB_PASSWORD={DB}")
            .replace("GHOST_MAIL_PASSWORD=", f"GHOST_MAIL_PASSWORD={MAIL}")
            .replace("GHOST_OWNER_EMAIL=", f"GHOST_OWNER_EMAIL={OWNER}"),
        )
        assert_secure_file(self, self.target, self.chown)
        self.assertEqual(os.listdir(self.etc), ["alpha.env"])

    def test_prints_key_names_only(self):
        code, out, err = self.run_main(VALUES)
        self.assertEqual(code, 0)
        self.assert_no_sentinel(out, err)
        for key in VALUES:
            self.assertIn(f"key {key}", out)
        self.assertEqual(err, "")

    def test_a_rerun_with_the_same_values_changes_nothing(self):
        self.assertEqual(self.run_main(VALUES)[0], 0)
        before = os.stat(self.target)
        code, out, err = self.run_main(VALUES)
        self.assertEqual(code, 0, err)
        self.assertTrue(out.startswith("unchanged "))
        after = os.stat(self.target)
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))
        assert_secure_file(self, self.target)
        self.assertEqual(os.listdir(self.etc), ["alpha.env"])

    def test_an_identical_file_with_a_loose_mode_is_tightened(self):
        self.assertEqual(self.run_main(VALUES)[0], 0)
        os.chmod(self.target, 0o644)
        self.assertEqual(self.run_main(VALUES)[0], 0)
        assert_secure_file(self, self.target)

    def test_a_different_existing_file_is_refused_and_kept(self):
        self.assertEqual(self.run_main(VALUES)[0], 0)
        with open(self.target, encoding="utf-8") as handle:
            kept = handle.read()
        changed = dict(VALUES, GHOST_DB_PASSWORD="sentinel-db-rotated-1111")
        err = self.refused(changed)
        self.assertIn("different content", err)
        self.assertNotIn("sentinel-db-rotated-1111", err)
        with open(self.target, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), kept)
        self.assertEqual(os.listdir(self.etc), ["alpha.env"])

    def test_a_symlink_at_the_target_is_refused_and_not_written_through(self):
        victim = os.path.join(self._dir.name, "victim")
        with open(victim, "w", encoding="utf-8") as handle:
            handle.write("untouched\n")
        os.symlink(victim, self.target)
        self.refused()
        with open(victim, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "untouched\n")
        self.assertEqual(os.listdir(self.etc), ["alpha.env"])

    def test_a_dangling_symlink_at_the_target_is_refused(self):
        os.symlink(os.path.join(self._dir.name, "missing"), self.target)
        self.refused()
        self.assertFalse(os.path.exists(os.path.join(self._dir.name, "missing")))

    def test_a_directory_at_the_target_is_refused(self):
        os.mkdir(self.target)
        self.refused()

    def test_a_file_that_appears_during_the_write_is_not_replaced(self):
        real_link = os.link

        def racing_link(source, destination, **kwargs):
            with open(destination, "w", encoding="utf-8") as handle:
                handle.write("someone else\n")
            return real_link(source, destination, **kwargs)

        with mock.patch.object(rts.os, "link", racing_link):
            err = self.refused()
        self.assertIn("appeared", err)
        with open(self.target, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "someone else\n")
        self.assertEqual(os.listdir(self.etc), ["alpha.env"])


class Refusals(Host):
    def test_a_missing_key(self):
        err = self.refused({k: v for k, v in VALUES.items() if k != "GHOST_MAIL_PASSWORD"})
        self.assertIn("GHOST_MAIL_PASSWORD", err)
        self.assert_nothing_left()

    def test_an_extra_key(self):
        err = self.refused(dict(VALUES, GHOST_UNKNOWN="x"))
        self.assertIn("GHOST_UNKNOWN", err)
        self.assert_nothing_left()

    def test_an_empty_value(self):
        err = self.refused(dict(VALUES, GHOST_MAIL_PASSWORD=""))
        self.assertIn("GHOST_MAIL_PASSWORD is empty", err)
        self.assert_nothing_left()

    def test_a_control_character_that_would_add_a_variable(self):
        for bad in ("pw\nGHOST_DB_PASSWORD=attacker", "pw\rx", "pw\x00x", "pw\x1bx", "pw\x85x"):
            with self.subTest(bad=bad):
                err = self.refused(dict(VALUES, GHOST_MAIL_PASSWORD=bad))
                self.assertIn("control character", err)
                self.assertNotIn("attacker", err)
        self.assert_nothing_left()

    def test_an_owner_address_with_whitespace_or_no_at_sign(self):
        for bad in ("sentinel-owner-9b63cf45 @example.test", "sentinel-owner-9b63cf45.example.test"):
            with self.subTest(bad=bad):
                err = self.refused(dict(VALUES, GHOST_OWNER_EMAIL=bad))
                self.assertIn("GHOST_OWNER_EMAIL is not a valid email address", err)
        self.assert_nothing_left()

    def test_a_value_that_is_not_a_string(self):
        self.refused(dict(VALUES, GHOST_DB_PASSWORD=12345))
        self.assert_nothing_left()

    def test_a_key_given_twice_in_the_json(self):
        raw = (
            '{"GHOST_DB_PASSWORD": "sentinel-db-4c1e7a90", "GHOST_DB_PASSWORD": "sentinel-db-4c1e7a90",'
            ' "GHOST_MAIL_PASSWORD": "x", "GHOST_OWNER_EMAIL": "a@b"}'
        )
        err = self.refused(raw=raw)
        self.assertIn("more than once", err)
        self.assert_nothing_left()

    def test_stdin_that_is_not_a_json_object(self):
        for raw in ("not json sentinel-db-4c1e7a90", '["sentinel-db-4c1e7a90"]', ""):
            with self.subTest(raw=raw):
                self.refused(raw=raw)
        self.assert_nothing_left()

    def test_stdin_larger_than_the_cap(self):
        self.refused(raw=" " * (rts.MAX_STDIN_BYTES + 1))
        self.assert_nothing_left()

    def test_a_template_carrying_a_value(self):
        with open(self.template_file, "a", encoding="utf-8") as handle:
            handle.write("GHOST_LEAKED=sentinel-db-4c1e7a90\n")
        self.refused()
        self.assert_nothing_left()

    def test_a_template_naming_a_key_twice(self):
        with open(self.template_file, "a", encoding="utf-8") as handle:
            handle.write("GHOST_DB_PASSWORD=\n")
        self.refused()
        self.assert_nothing_left()

    def test_a_slug_that_is_not_a_tenant_slug(self):
        for slug in ("Alpha", "../alpha", "alpha/beta", "-alpha", "", "website"):
            with self.subTest(slug=slug):
                self.refused(slug=slug)
        self.assert_nothing_left()

    def test_a_missing_template_file(self):
        os.unlink(self.template_file)
        self.refused()
        self.assert_nothing_left()

    def test_not_root(self):
        self.refused(geteuid=lambda: 1000)
        self.assert_nothing_left()

    def test_a_failed_chown_leaves_no_file_and_no_temp_file(self):
        def failing(fd, uid, gid):
            raise PermissionError(1, "Operation not permitted")

        err = self.refused(fchown=failing)
        self.assertIn("Operation not permitted", err)
        self.assert_nothing_left()

    def test_a_failed_write_leaves_no_file_and_no_temp_file(self):
        with mock.patch.object(rts.os, "fsync", side_effect=OSError(5, "Input/output error")):
            self.refused()
        self.assert_nothing_left()


class Usage(Host):
    def test_a_terminal_on_stdin_is_a_usage_error_and_writes_nothing(self):
        class Terminal(io.StringIO):
            def isatty(self):
                return True

        with contextlib.redirect_stderr(io.StringIO()):
            code = rts.main(
                ["--slug", "alpha", "--template-file", self.template_file, "--etc-dir", self.etc],
                geteuid=lambda: 0,
                stdin=Terminal(),
            )
        self.assertEqual(code, 2)
        self.assert_nothing_left()

    def test_missing_arguments_exit_2(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            rts.main(["--slug", "alpha"], geteuid=lambda: 0, stdin=io.StringIO("{}"))
        self.assertEqual(raised.exception.code, 2)

    def test_the_values_have_no_command_line_form(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            rts.main(
                ["--slug", "alpha", "--template-file", self.template_file, "--value", DB],
                geteuid=lambda: 0,
                stdin=io.StringIO("{}"),
            )
        self.assertEqual(raised.exception.code, 2)

    def test_it_reuses_the_volume_script_slug_rule(self):
        import provision_tenant_volume as ptv

        self.assertIs(rts.validate_slug, ptv.validate_slug)


class Sabotage(Host):
    """Control cases: the mode and ownership check must fail on a script that
    breaks the control, so a green run above is not an all-clear with no case."""

    def mutated(self, old: str, new: str) -> types.ModuleType:
        with open(rts.__file__, encoding="utf-8") as handle:
            source = handle.read()
        self.assertIn(old, source, "sabotage target not found; update the mutation")
        module = types.ModuleType("render_tenant_secrets_sabotaged")
        module.__file__ = rts.__file__
        exec(compile(source.replace(old, new), rts.__file__, "exec"), module.__dict__)
        return module

    def test_a_script_that_writes_mode_0644_fails_the_check(self):
        broken = self.mutated("FILE_MODE = 0o600", "FILE_MODE = 0o644")
        code, _out, err = self.run_main(VALUES, module=broken)
        self.assertEqual(code, 0, err)
        with self.assertRaises(AssertionError):
            assert_secure_file(self, self.target, self.chown)

    def test_a_script_that_never_chowns_fails_the_check(self):
        broken = self.mutated("fchown(fd, OWNER_UID, OWNER_GID)", "pass")
        code, _out, err = self.run_main(VALUES, module=broken)
        self.assertEqual(code, 0, err)
        with self.assertRaises(AssertionError):
            assert_secure_file(self, self.target, self.chown)

    def test_the_real_script_passes_the_same_check(self):
        code, _out, err = self.run_main(VALUES)
        self.assertEqual(code, 0, err)
        assert_secure_file(self, self.target, self.chown)


if __name__ == "__main__":
    unittest.main()
