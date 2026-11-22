import io
import json
import os
import pathlib
import tempfile
import unittest
from contextlib import redirect_stdout

import scan_edge_access_log as scan_mod

PASSPHRASE = "correct horse battery"


def entry(uri: str, referer: str | None = None, status: int = 200) -> str:
    headers = {"User-Agent": ["test"]}
    if referer is not None:
        headers["Referer"] = [referer]
    return json.dumps({
        "level": "info", "ts": 1.9e9, "logger": "http.log.access.log0", "msg": "handled request",
        "request": {"remote_ip": "203.0.113.7", "method": "GET", "host": "a.demo.example",
                    "uri": uri, "headers": headers},
        "status": status,
    })


class ScanTests(unittest.TestCase):
    def run_main(self, lines: list[str], passphrases: list[str] | None = None) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as tmp:
            log = pathlib.Path(tmp) / "access.log"
            log.write_text("\n".join(lines) + "\n", encoding="utf-8")
            args = [str(log)]
            if passphrases is not None:
                known = pathlib.Path(tmp) / "known.txt"
                known.write_text("\n".join(passphrases) + "\n", encoding="utf-8")
                args += ["--passphrase-file", str(known)]
            out = io.StringIO()
            with redirect_stdout(out):
                code = scan_mod.main(args)
            return code, out.getvalue()

    def test_a_clean_log_is_green(self):
        code, out = self.run_main([entry("/"), entry("/ghost/?bl_break_glass=abc"), entry("/__gate/login", status=303)],
                                  [PASSPHRASE])
        self.assertEqual(code, scan_mod.EXIT_CLEAN)
        self.assertIn("CLEAN: 3 entries", out)

    def test_a_passphrase_parameter_is_red_on_any_path(self):
        for uri in ("/?passphrase=x", "/ghost/?Password=x", "/a/b?q=1&PWD=x", "/?pass=", "/?%70assphrase=x"):
            with self.subTest(uri=uri):
                code, out = self.run_main([entry("/"), entry(uri)])
                self.assertEqual(code, scan_mod.EXIT_FOUND)
                self.assertIn("RED: line 2", out)

    def test_a_known_passphrase_is_red_however_it_is_written(self):
        for uri in (
            "/correct-horse-battery",
            "/?x=correct%20horse%20battery",
            "/?x=Correct+Horse+Battery",
            "/p/correct_horse_battery/q",
            "/?d=correct.horse.battery",
        ):
            with self.subTest(uri=uri):
                code, out = self.run_main([entry(uri)], [PASSPHRASE])
                self.assertEqual(code, scan_mod.EXIT_FOUND)
                self.assertIn("a known passphrase appears", out)

    def test_a_known_passphrase_in_a_referer_is_red(self):
        code, _ = self.run_main([entry("/", referer="https://a.demo.example/?x=correct-horse-battery")], [PASSPHRASE])
        self.assertEqual(code, scan_mod.EXIT_FOUND)

    def test_a_known_passphrase_is_not_searched_for_without_being_given(self):
        code, _ = self.run_main([entry("/correct-horse-battery")])
        self.assertEqual(code, scan_mod.EXIT_CLEAN)

    def test_a_finding_never_prints_the_passphrase_or_the_url(self):
        _, out = self.run_main([entry("/?passphrase=correct-horse-battery")], [PASSPHRASE])
        self.assertNotIn("correct", out)
        self.assertNotIn("horse", out)
        self.assertNotIn("/?", out)

    def test_an_empty_log_cannot_be_certified(self):
        code, out = self.run_main([""])
        self.assertEqual(code, scan_mod.EXIT_UNREADABLE)
        self.assertIn("no entries", out)

    def test_a_line_that_is_not_an_entry_cannot_be_certified(self):
        for bad in ("not json", "[]", json.dumps({"request": {}}), json.dumps({"request": {"uri": 5}})):
            with self.subTest(bad=bad):
                code, _ = self.run_main([entry("/"), bad])
                self.assertEqual(code, scan_mod.EXIT_UNREADABLE)

    def test_a_missing_file_cannot_be_certified(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = scan_mod.main([os.path.join(tempfile.gettempdir(), "no-such-access-log")])
        self.assertEqual(code, scan_mod.EXIT_UNREADABLE)

    def test_a_known_passphrase_too_short_to_search_for_is_refused(self):
        code, out = self.run_main([entry("/")], ["abc"])
        self.assertEqual(code, scan_mod.EXIT_UNREADABLE)
        self.assertIn("too short", out)

    def test_blank_lines_in_the_passphrase_file_are_ignored(self):
        code, _ = self.run_main([entry("/")], ["", PASSPHRASE, ""])
        self.assertEqual(code, scan_mod.EXIT_CLEAN)

    def test_a_referer_header_of_the_wrong_shape_is_ignored(self):
        line = json.loads(entry("/"))
        line["request"]["headers"]["Referer"] = "https://a.demo.example/"
        line2 = json.loads(entry("/"))
        line2["request"]["headers"] = "none"
        code, _ = self.run_main([json.dumps(line), json.dumps(line2)])
        self.assertEqual(code, scan_mod.EXIT_CLEAN)


if __name__ == "__main__":
    unittest.main()
