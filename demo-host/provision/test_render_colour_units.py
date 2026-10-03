#!/usr/bin/env python3
"""Unit tests for render_colour_units.

systemd itself is not available here, so a small model of its drop-in
semantics (an empty assignment clears a list-valued directive; a later one
appends) is applied to a verbatim copy of the generic template's
directives, and the effective unit is asserted. The template lives in
another repository; the copy below is the part of it these tests depend on.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import branchleft_slot as bs
import render_colour_units as rcu
import render_slot_sudoers as rss

TEMPLATE = {
    ("Unit", "AssertPathExists"): ["/etc/branchleft/%i.image.env"],
    ("Service", "WorkingDirectory"): ["/opt/branchleft/%i"],
    ("Service", "EnvironmentFile"): ["/etc/branchleft/%i.image.env", "-/etc/branchleft/%i.env"],
    ("Service", "ExecStartPre"): ["/usr/bin/docker compose pull --quiet"],
    ("Service", "ExecStart"): ["/usr/bin/docker compose up -d --remove-orphans --wait"],
}

SIDECAR = "/usr/bin/python3 /usr/local/lib/branchleft/demo_sidecar.py"


def effective(dropin: str) -> dict[tuple[str, str], list[str]]:
    result = {key: list(values) for key, values in TEMPLATE.items()}
    section = ""
    for line in dropin.splitlines():
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            section = line.strip("[]")
            continue
        key, _, value = line.partition("=")
        if value == "":
            result[(section, key)] = []
        else:
            result.setdefault((section, key), []).append(value)
    return result


def run_commands(
    dropin: str, *, start_ok: bool, then_stop: bool, post_ok: bool = True
) -> list[str]:
    """The commands systemd executes for a unit, per systemd.service(5):
    ExecStartPost runs only after a successful ExecStart, ExecStop runs only
    after a start that succeeded all the way through (a failed ExecStartPost
    included, conservatively), ExecStopPost runs whatever the start's
    outcome, and `systemctl stop` on a unit already failed is a no-op."""
    eff = effective(dropin)
    ran = list(eff[("Service", "ExecStart")])
    stopped = False
    if start_ok:
        ran += eff.get(("Service", "ExecStartPost"), [])
        stopped = post_ok and then_stop
    if stopped:
        ran += eff.get(("Service", "ExecStop"), [])
    ran += eff.get(("Service", "ExecStopPost"), []) if (stopped or not start_ok or not post_ok) else []
    return ran


class InstanceTests(unittest.TestCase):
    def test_instance_names_are_the_ones_sudoers_enumerates(self):
        sudoers = rss.render()
        for slot in rss.SLOT_NAMES:
            for colour in rss.COLOURS:
                self.assertIn(f"branchleft-slot {slot} {colour} start", sudoers)
                self.assertEqual(rcu.instance(slot, colour), f"branchleft-compose@demo-{slot}-{colour}")

    def test_fourteen_instances(self):
        self.assertEqual(len(rcu.render_all()), 14)

    def test_colour_and_slot_tables_are_the_wrappers(self):
        self.assertEqual(rcu.COLOURS, rss.COLOURS)
        self.assertEqual(rcu.SLOT_NAMES, rss.SLOT_NAMES)


class EffectiveUnitTests(unittest.TestCase):
    def test_template_requirements_are_cleared(self):
        eff = effective(rcu.render("2", "a"))
        self.assertNotIn("/etc/branchleft/%i.image.env", eff[("Unit", "AssertPathExists")])
        self.assertEqual(eff[("Service", "ExecStartPre")], [])

    def test_starts_exactly_one_colours_service_from_the_slot_compose_file(self):
        for colour in ("a", "b"):
            eff = effective(rcu.render("3", colour))
            self.assertEqual(eff[("Service", "WorkingDirectory")], ["/opt/branchleft/demo-3"])
            self.assertEqual(
                eff[("Service", "ExecStart")],
                [f"/usr/bin/docker compose up -d --wait ghost-{colour}"],
            )

    def test_stop_stops_only_that_colour(self):
        eff = effective(rcu.render("4", "b"))
        self.assertEqual(
            eff[("Service", "ExecStop")],
            [f"{SIDECAR} stop 4 b", "/usr/bin/docker compose stop ghost-b"],
        )

    def test_no_remove_orphans_which_would_remove_the_other_colour(self):
        for text in rcu.render_all().values():
            self.assertNotIn("--remove-orphans", text)
            self.assertNotIn(" down", text)

    def test_env_files_are_the_slot_image_pin_and_this_colours_secrets(self):
        eff = effective(rcu.render("5", "a"))
        self.assertEqual(
            eff[("Service", "EnvironmentFile")],
            [
                "/opt/branchleft/demo-5/image.env",
                "/etc/branchleft/demo-sidecar.image.env",
                "-/etc/branchleft/demo-5-a.env",
            ],
        )

    def test_secrets_file_name_matches_what_reset_removes(self):
        # branchleft_slot.py's reset removes ETC_DIR/demo-<slot>-<colour>.env.
        self.assertEqual(rcu.ETC_DIR, bs.ETC_DIR)

    def test_the_unit_runs_no_container_itself_the_sidecar_script_does(self):
        for text in rcu.render_all().values():
            self.assertNotIn("docker run", text)
            self.assertNotIn("network_mode", text)
            self.assertNotIn("--network", text)

    def test_the_sidecar_digest_file_is_required_and_read_by_the_unit(self):
        for text in rcu.render_all().values():
            eff = effective(text)
            self.assertIn("/etc/branchleft/demo-sidecar.image.env", eff[("Unit", "AssertPathExists")])
            self.assertIn("/etc/branchleft/demo-sidecar.image.env", eff[("Service", "EnvironmentFile")])
            self.assertNotIn("-/etc/branchleft/demo-sidecar.image.env", eff[("Service", "EnvironmentFile")])

    def test_the_sidecar_starts_after_its_own_colour_only(self):
        for slot in rss.SLOT_NAMES:
            for colour in rss.COLOURS:
                eff = effective(rcu.render(slot, colour))
                self.assertEqual(eff[("Service", "ExecStartPost")], [f"{SIDECAR} start {slot} {colour}"])

    def test_the_sidecar_is_stopped_in_both_stop_phases_for_its_own_colour_only(self):
        for slot in rss.SLOT_NAMES:
            for colour in rss.COLOURS:
                eff = effective(rcu.render(slot, colour))
                for phase in ("ExecStop", "ExecStopPost"):
                    self.assertIn(f"{SIDECAR} stop {slot} {colour}", eff[("Service", phase)])
                    other = "b" if colour == "a" else "a"
                    self.assertNotIn(f"stop {slot} {other}", " ".join(eff[("Service", phase)]))

    def test_template_start_post_is_cleared(self):
        template = dict(TEMPLATE)
        self.assertNotIn(("Service", "ExecStartPost"), template)
        self.assertIn("ExecStartPost=\n", rcu.render("0", "a"))
        self.assertIn("ExecStop=\n", rcu.render("0", "a"))

    def test_script_path_is_the_one_the_sidecar_doc_installs(self):
        self.assertEqual(rcu.SIDECAR_SCRIPT, "/usr/local/lib/branchleft/demo_sidecar.py")

    def test_every_instance_is_distinct(self):
        self.assertEqual(len(set(rcu.render_all().values())), 14)


class UnitStateTests(unittest.TestCase):
    STOP = "/usr/bin/docker compose stop ghost-a"
    SIDECAR_STOP = f"{SIDECAR} stop 1 a"

    def test_failed_start_still_stops_the_container(self):
        ran = run_commands(rcu.render("1", "a"), start_ok=False, then_stop=False)
        self.assertIn(self.STOP, ran)

    def test_failed_start_stops_only_this_colour(self):
        ran = run_commands(rcu.render("1", "a"), start_ok=False, then_stop=False)
        self.assertNotIn("ghost-b", " ".join(ran))

    def test_started_then_stopped_stops_the_container(self):
        ran = run_commands(rcu.render("1", "a"), start_ok=True, then_stop=True)
        self.assertIn(self.STOP, ran)

    def test_a_failed_sidecar_start_removes_the_sidecar_and_stops_ghost(self):
        ran = run_commands(rcu.render("1", "a"), start_ok=True, then_stop=False, post_ok=False)
        self.assertEqual(ran[0], "/usr/bin/docker compose up -d --wait ghost-a")
        self.assertIn(f"{SIDECAR} start 1 a", ran)
        self.assertIn(self.SIDECAR_STOP, ran)
        self.assertIn(self.STOP, ran)

    def test_a_failed_ghost_start_never_starts_the_sidecar_and_still_removes_it(self):
        ran = run_commands(rcu.render("1", "a"), start_ok=False, then_stop=False)
        self.assertNotIn(f"{SIDECAR} start 1 a", ran)
        self.assertIn(self.SIDECAR_STOP, ran)

    def test_a_clean_stop_removes_the_sidecar_in_both_phases(self):
        ran = run_commands(rcu.render("1", "a"), start_ok=True, then_stop=True)
        self.assertEqual(ran.count(self.SIDECAR_STOP), 2)

    def test_the_sidecar_is_stopped_before_ghost(self):
        eff = effective(rcu.render("1", "a"))
        for phase in ("ExecStop", "ExecStopPost"):
            self.assertLess(
                eff[("Service", phase)].index(self.SIDECAR_STOP),
                eff[("Service", phase)].index(self.STOP),
            )


class RefusalTests(unittest.TestCase):
    def test_unknown_slot_or_colour_is_refused(self):
        for slot, colour in (("7", "a"), ("0", "c"), ("0 ", "a"), ("../1", "a"), ("0", "a b")):
            with self.assertRaises(ValueError):
                rcu.render(slot, colour)


class InstallTests(unittest.TestCase):
    def test_writes_every_dropin_at_the_systemd_path(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch("render_colour_units.os.chown"):
            paths = rcu.install(tmp)
            self.assertEqual(len(paths), 14)
            for slot in rss.SLOT_NAMES:
                for colour in rss.COLOURS:
                    path = os.path.join(
                        tmp, f"branchleft-compose@demo-{slot}-{colour}.service.d", "colour.conf"
                    )
                    self.assertIn(path, paths)
                    with open(path) as handle:
                        self.assertEqual(handle.read(), rcu.render(slot, colour))
                    self.assertEqual(os.stat(path).st_mode & 0o777, 0o644)

    def test_chowns_to_root_and_does_not_mask_a_refusal(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch(
            "render_colour_units.os.chown", side_effect=PermissionError
        ) as chown:
            with self.assertRaises(PermissionError):
                rcu.install(tmp)
            chown.assert_called()
            self.assertEqual(chown.call_args.args[1:], (0, 0))
            leftovers = [f for _, _, files in os.walk(tmp) for f in files]
            self.assertEqual(leftovers, [])

    def test_rerun_replaces_in_place(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch("render_colour_units.os.chown"):
            rcu.install(tmp)
            rcu.install(tmp)
            self.assertEqual(len(os.listdir(tmp)), 14)


class MainTests(unittest.TestCase):
    def test_prints_all_by_default(self):
        with mock.patch("sys.stdout") as out:
            self.assertEqual(rcu.main([]), 0)
        written = "".join(c.args[0] for c in out.write.call_args_list)
        self.assertIn("## branchleft-compose@demo-6-b", written)

    def test_install_flag(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch("render_colour_units.os.chown"):
            self.assertEqual(rcu.main(["--install", tmp]), 0)
            self.assertEqual(len(os.listdir(tmp)), 14)


if __name__ == "__main__":
    unittest.main()
