#!/usr/bin/env python3
"""Unit tests for export_release: the export is removed only when ops1's
confirmation matches the bytes on the demo host, and in no other case."""

from __future__ import annotations

import contextlib
import hashlib
import io
import os
import tempfile
import unittest
from typing import Iterator
from unittest import mock

import export_release as er

STEM = "demo-a1b2-export-2026-11-20T151651123Z"
ARCHIVE = STEM + ".tar.age"
MANIFEST = STEM + ".manifest.json"
CIPHERTEXT = b"age-encryption.org/v1\n-> X25519 stanza\nciphertext bytes"
GOOD = hashlib.sha256(CIPHERTEXT).hexdigest()
ALL = sorted([ARCHIVE, MANIFEST, "unrelated.txt"])


@contextlib.contextmanager
def export_dir() -> Iterator[str]:
    """A 0700 directory holding what the bundler writes, plus one stranger."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "exports")
        os.mkdir(path, 0o700)
        os.chmod(path, 0o700)
        for name, data in ((ARCHIVE, CIPHERTEXT), (MANIFEST, b"{}"), ("unrelated.txt", b"keep")):
            with open(os.path.join(path, name), "wb") as handle:
                handle.write(data)
            os.chmod(os.path.join(path, name), 0o600)
        yield path


def names(path: str) -> list[str]:
    return sorted(os.listdir(path))


class RemovesOnlyWhenConfirmedTests(unittest.TestCase):
    def test_a_matching_confirmation_removes_the_archive_and_its_manifest_only(self) -> None:
        with export_dir() as path:
            er.release(path, ARCHIVE, GOOD)
            self.assertEqual(names(path), ["unrelated.txt"])

    def test_the_run_prints_the_directory_before_and_after(self) -> None:
        with export_dir() as path:
            lines: list[str] = []
            er.release(path, ARCHIVE, GOOD, lines)
            self.assertEqual(lines[0], "before: " + ", ".join(ALL))
            self.assertEqual(lines[-1], "after: unrelated.txt")
            self.assertIn(f"removed: {ARCHIVE} sha256 {GOOD}", lines)

    def test_a_confirmation_for_other_bytes_removes_nothing(self) -> None:
        with export_dir() as path:
            other = hashlib.sha256(b"something else").hexdigest()
            with self.assertRaises(er.ReleaseRefused):
                er.release(path, ARCHIVE, other)
            self.assertEqual(names(path), ALL)

    def test_a_failed_pull_is_retried_by_the_same_call_with_the_right_digest(self) -> None:
        with export_dir() as path:
            with self.assertRaises(er.ReleaseRefused):
                er.release(path, ARCHIVE, "0" * 64)
            self.assertEqual(names(path), ALL)
            er.release(path, ARCHIVE, GOOD)
            self.assertEqual(names(path), ["unrelated.txt"])

    def test_the_digest_is_read_from_the_file_now_not_from_a_record(self) -> None:
        with export_dir() as path:
            with open(os.path.join(path, ARCHIVE), "ab") as handle:
                handle.write(b" grown after the pull")
            with self.assertRaises(er.ReleaseRefused):
                er.release(path, ARCHIVE, GOOD)
            self.assertIn(ARCHIVE, names(path))

    def test_the_archive_goes_last_so_a_cut_short_run_is_finished_by_a_rerun(self) -> None:
        with export_dir() as path:
            real_unlink = os.unlink

            def fail_on_archive(target: str, *args: object, **kwargs: object) -> None:
                if str(target).endswith(ARCHIVE):
                    raise OSError("simulated failure")
                real_unlink(target)

            with mock.patch("export_release.os.unlink", side_effect=fail_on_archive):
                with self.assertRaises(OSError):
                    er.release(path, ARCHIVE, GOOD)
            self.assertEqual(names(path), sorted([ARCHIVE, "unrelated.txt"]))
            er.release(path, ARCHIVE, GOOD)
            self.assertEqual(names(path), ["unrelated.txt"])


class ConfirmationIsStrictTests(unittest.TestCase):
    def test_anything_but_a_lowercase_sha256_is_not_a_confirmation(self) -> None:
        for bad in ("", "abc", GOOD.upper(), GOOD[:-1], GOOD + "0", "g" * 64, " " + GOOD, GOOD + "\n"):
            with self.subTest(bad=bad):
                with export_dir() as path:
                    with self.assertRaises(er.ReleaseRefused):
                        er.release(path, ARCHIVE, bad)
                    self.assertEqual(names(path), ALL)


class OnlyTheBundlersFilesAreNamedTests(unittest.TestCase):
    def test_a_name_the_bundler_does_not_write_is_refused(self) -> None:
        for bad in (
            "../" + ARCHIVE,
            "sub/" + ARCHIVE,
            "/etc/passwd",
            "unrelated.txt",
            MANIFEST,
            STEM + ".tar.age.bak",
            STEM + ".tar",
            "*.tar.age",
            "-export-2026-11-20T151651123Z.tar.age",
            ARCHIVE + "\n",
            "",
        ):
            with self.subTest(bad=bad):
                with export_dir() as path:
                    with self.assertRaises(er.ReleaseRefused):
                        er.release(path, bad, GOOD)
                    self.assertEqual(names(path), ALL)

    def test_a_file_the_bundler_did_not_write_is_kept_even_with_its_own_digest(self) -> None:
        with export_dir() as path:
            for name, data in (("unrelated.txt", b"keep"), (MANIFEST, b"{}")):
                with self.subTest(name=name):
                    with self.assertRaises(er.ReleaseRefused):
                        er.release(path, name, hashlib.sha256(data).hexdigest())
                    self.assertEqual(names(path), ALL)

    def test_a_path_that_climbs_or_descends_is_kept_even_with_its_own_digest(self) -> None:
        with export_dir() as path:
            parent = os.path.dirname(path)
            os.mkdir(os.path.join(path, "sub"), 0o700)
            for relative, where in (
                ("../" + ARCHIVE, os.path.join(parent, ARCHIVE)),
                ("sub/" + ARCHIVE, os.path.join(path, "sub", ARCHIVE)),
            ):
                with self.subTest(relative=relative):
                    with open(where, "wb") as handle:
                        handle.write(CIPHERTEXT)
                    with self.assertRaises(er.ReleaseRefused):
                        er.release(path, relative, GOOD)
                    self.assertTrue(os.path.exists(where))

    def test_the_manifest_of_another_export_is_left_alone(self) -> None:
        with export_dir() as path:
            other = "demo-zzzz-export-2026-11-20T151651123Z.manifest.json"
            with open(os.path.join(path, other), "w", encoding="utf-8") as handle:
                handle.write("{}")
            er.release(path, ARCHIVE, GOOD)
            self.assertEqual(names(path), sorted([other, "unrelated.txt"]))


class TheDirectoryMustBeThePrivateOneTests(unittest.TestCase):
    def test_a_relative_directory_is_refused(self) -> None:
        with export_dir() as path:
            parent = os.path.dirname(path)
            old = os.getcwd()
            os.chdir(parent)
            try:
                with self.assertRaises(er.ReleaseRefused):
                    er.release("exports", ARCHIVE, GOOD)
            finally:
                os.chdir(old)
            self.assertIn(ARCHIVE, names(path))

    def test_a_directory_others_can_enter_is_refused(self) -> None:
        for mode in (0o750, 0o705, 0o755, 0o770):
            with self.subTest(mode=oct(mode)):
                with export_dir() as path:
                    os.chmod(path, mode)
                    with self.assertRaises(er.ReleaseRefused):
                        er.release(path, ARCHIVE, GOOD)
                    os.chmod(path, 0o700)
                    self.assertIn(ARCHIVE, names(path))

    def test_a_symlink_to_the_directory_is_refused(self) -> None:
        with export_dir() as path:
            link = os.path.join(os.path.dirname(path), "link")
            os.symlink(path, link)
            with self.assertRaises(er.ReleaseRefused):
                er.release(link, ARCHIVE, GOOD)
            self.assertIn(ARCHIVE, names(path))

    def test_a_missing_directory_is_refused(self) -> None:
        with export_dir() as path:
            with self.assertRaises(er.ReleaseRefused):
                er.release(os.path.join(path, "nope"), ARCHIVE, GOOD)


class TheArchiveMustBeAPlainFileTests(unittest.TestCase):
    def test_a_missing_archive_is_its_own_answer_and_touches_nothing(self) -> None:
        with export_dir() as path:
            os.unlink(os.path.join(path, ARCHIVE))
            with self.assertRaises(er.ReleaseRefused) as ctx:
                er.release(path, ARCHIVE, GOOD)
            self.assertEqual(ctx.exception.code, er.EXIT_NOTHING_THERE)
            self.assertEqual(names(path), sorted([MANIFEST, "unrelated.txt"]))

    def test_a_symlink_named_like_the_archive_is_refused_and_its_target_kept(self) -> None:
        with export_dir() as path:
            target = os.path.join(path, "unrelated.txt")
            os.unlink(os.path.join(path, ARCHIVE))
            os.symlink(target, os.path.join(path, ARCHIVE))
            digest = hashlib.sha256(b"keep").hexdigest()
            with self.assertRaises(er.ReleaseRefused):
                er.release(path, ARCHIVE, digest)
            self.assertTrue(os.path.exists(target))

    def test_a_directory_named_like_the_archive_is_refused(self) -> None:
        with export_dir() as path:
            os.unlink(os.path.join(path, ARCHIVE))
            os.mkdir(os.path.join(path, ARCHIVE), 0o700)
            with self.assertRaises(er.ReleaseRefused):
                er.release(path, ARCHIVE, GOOD)
            self.assertTrue(os.path.isdir(os.path.join(path, ARCHIVE)))

    def test_an_archive_that_is_still_there_after_its_removal_is_not_called_removed(self) -> None:
        with export_dir() as path:
            with mock.patch("export_release.os.unlink"):
                with self.assertRaises(er.ReleaseRefused):
                    er.release(path, ARCHIVE, GOOD)
            self.assertIn(ARCHIVE, names(path))

    def test_a_file_swapped_in_after_the_check_is_not_removed(self) -> None:
        with export_dir() as path:
            archive_path = os.path.join(path, ARCHIVE)
            real_hash = er.sha256_of_open_file

            def hash_then_swap(fd: int) -> str:
                digest = real_hash(fd)
                os.unlink(archive_path)
                with open(archive_path, "wb") as handle:
                    handle.write(b"a different export")
                return digest

            with mock.patch("export_release.sha256_of_open_file", side_effect=hash_then_swap):
                with self.assertRaises(er.ReleaseRefused):
                    er.release(path, ARCHIVE, GOOD)
            self.assertEqual(names(path), ALL)


class CommandLineTests(unittest.TestCase):
    def run_main(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = er.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_success_exits_zero_and_prints_the_listing(self) -> None:
        with export_dir() as path:
            code, out, _err = self.run_main("--dest-dir", path, "--archive", ARCHIVE, "--pulled-sha256", GOOD)
            self.assertEqual(code, 0)
            self.assertIn("export-release: after: unrelated.txt", out)

    def test_a_refusal_exits_two_with_one_refused_line(self) -> None:
        with export_dir() as path:
            code, _out, err = self.run_main("--dest-dir", path, "--archive", ARCHIVE, "--pulled-sha256", "0" * 64)
            self.assertEqual(code, er.EXIT_REFUSED)
            self.assertTrue(err.startswith("REFUSED: "))
            self.assertEqual(err.count("\n"), 1)
            self.assertIn(ARCHIVE, names(path))

    def test_a_missing_archive_exits_three(self) -> None:
        with export_dir() as path:
            os.unlink(os.path.join(path, ARCHIVE))
            code, _out, _err = self.run_main("--dest-dir", path, "--archive", ARCHIVE, "--pulled-sha256", GOOD)
            self.assertEqual(code, er.EXIT_NOTHING_THERE)

    def test_a_missing_confirmation_is_a_usage_error_and_removes_nothing(self) -> None:
        with export_dir() as path:
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as ctx:
                    er.main(["--dest-dir", path, "--archive", ARCHIVE])
            self.assertEqual(ctx.exception.code, 2)
            self.assertIn(ARCHIVE, names(path))


if __name__ == "__main__":
    unittest.main()
