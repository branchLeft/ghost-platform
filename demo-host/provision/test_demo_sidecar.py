#!/usr/bin/env python3
"""Tests for demo_sidecar and provision_socket_dirs.

`start` and `stop` are driven against a fake `docker` executable that keeps
the set of existing containers in a file, so "nothing left running" is read
off that state rather than off the commands issued. Directory modes and
ownership are real; a foreign owner is simulated by naming another uid.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import demo_sidecar as ds
import demo_uid_claims as duc
import drain_flag_dir as dfd
import health_router as hr
import provision_socket_dirs as psd
import render_slot_sudoers as rss

ME = os.getuid()
DIGEST = "ghcr.io/example/drain-sidecar@sha256:" + "a" * 64
GHOST_ID = "0123456789ab"

FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
state_path = os.environ["FAKE_DOCKER_STATE"]
state = json.load(open(state_path))
args = sys.argv[1:]
state["calls"].append(args)
def save():
    json.dump(state, open(state_path, "w"))
if args[:2] == ["compose", "ps"]:
    save()
    sys.stdout.write(os.environ.get("FAKE_PS_OUT", "0123456789ab\n"))
    sys.exit(int(os.environ.get("FAKE_PS_RC", "0")))
if args[0] == "run":
    name = args[args.index("--name") + 1]
    state["containers"][name] = args
    save()
    if os.environ.get("FAKE_RUN_FAIL"):
        sys.stderr.write("boom\n")
        sys.exit(125)
    sys.stdout.write("deadbeef\n")
    sys.exit(0)
if args[:2] == ["rm", "-f"]:
    name = args[2]
    if os.environ.get("FAKE_RM_FAIL"):
        save()
        sys.stderr.write("daemon error\n")
        sys.exit(1)
    state["containers"].pop(name, None)
    save()
    sys.exit(0)
if args[:2] == ["container", "inspect"]:
    save()
    sys.exit(0 if args[2] in state["containers"] else 1)
save()
sys.exit(2)
'''


class _Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ds", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, "socks")
        os.mkdir(self.root, 0o755)
        for slot in ("2",):
            for sub in (slot, f"{slot}/a", f"{slot}/b"):
                os.makedirs(os.path.join(self.root, sub), exist_ok=True)
                os.chmod(os.path.join(self.root, sub), 0o700)
        self.slot_dir = os.path.join(self.tmp, "slot")
        os.mkdir(self.slot_dir)
        self.flags = os.path.join(self.tmp, "flags")
        os.mkdir(self.flags)
        self.docker = os.path.join(self.tmp, "docker")
        Path(self.docker).write_text(FAKE_DOCKER.replace("#!/usr/bin/env python3", f"#!{sys.executable}"))
        os.chmod(self.docker, 0o755)
        self.state = os.path.join(self.tmp, "state.json")
        Path(self.state).write_text(json.dumps({"calls": [], "containers": {}}))
        env = {"FAKE_DOCKER_STATE": self.state}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def containers(self) -> dict:
        return json.loads(Path(self.state).read_text())["containers"]

    def calls(self) -> list:
        return json.loads(Path(self.state).read_text())["calls"]

    def start(self, slot="2", colour="a", env=None, **kwargs):
        return ds.start(
            slot, colour,
            env={ds.IMAGE_VARIABLE: DIGEST} if env is None else env,
            root=self.root, owner_uid=ME, slot_dir=self.slot_dir, flag_dir=self.flags,
            docker=self.docker, **kwargs,
        )  # fmt: skip


class StartTests(_Case):
    def test_starts_one_container_named_for_the_colour(self):
        self.start()
        self.assertEqual(list(self.containers()), ["demo-2-a-sidecar"])

    def test_it_joins_ghosts_network_namespace_and_opens_nothing(self):
        self.start()
        args = self.containers()["demo-2-a-sidecar"]
        self.assertEqual(args[args.index("--network") + 1], f"container:{GHOST_ID}")
        self.assertNotIn("-p", args)
        self.assertNotIn("--publish", args)
        self.assertNotIn("--privileged", args)

    def test_it_runs_as_the_router_uid(self):
        self.start()
        args = self.containers()["demo-2-a-sidecar"]
        self.assertEqual(args[args.index("--user") + 1], f"{ME}:{ME}")
        self.assertEqual(ds.ROUTER_UID, 30008)

    def test_it_is_confined(self):
        self.start()
        args = self.containers()["demo-2-a-sidecar"]
        self.assertIn("--read-only", args)
        self.assertEqual(args[args.index("--cap-drop") + 1], "ALL")
        self.assertEqual(args[args.index("--security-opt") + 1], "no-new-privileges:true")
        self.assertEqual(args[args.index("--pull") + 1], "never")
        self.assertEqual(args[args.index("--restart") + 1], "no")

    def test_the_image_is_the_pinned_digest_last(self):
        self.start()
        self.assertEqual(self.containers()["demo-2-a-sidecar"][-1], DIGEST)

    def test_colour_a_mounts_only_its_own_directory(self):
        self.start(colour="a")
        args = self.containers()["demo-2-a-sidecar"]
        mounts = [args[i + 1] for i, v in enumerate(args) if v == "--mount"]
        own = f"type=bind,src={self.root}/2/a,dst=/run/sidecar"
        self.assertIn(own, mounts)
        everything = " ".join(args)
        self.assertNotIn(f"{self.root}/2/b", everything)
        self.assertNotIn(f"src={self.root}/2,", everything)
        self.assertNotIn(f"src={self.root},", everything)
        socket_mounts = [m for m in mounts if "dst=/run/sidecar" in m]
        self.assertEqual(socket_mounts, [own])

    def test_colour_b_mounts_only_its_own_directory(self):
        self.start(colour="b")
        args = self.containers()["demo-2-b-sidecar"]
        everything = " ".join(args)
        self.assertIn(f"src={self.root}/2/b,dst=/run/sidecar", everything)
        self.assertNotIn(f"{self.root}/2/a", everything)

    def test_the_flag_directory_is_mounted_read_only_and_its_flag_is_this_colours(self):
        self.start(colour="b")
        args = self.containers()["demo-2-b-sidecar"]
        mounts = [args[i + 1] for i, v in enumerate(args) if v == "--mount"]
        self.assertIn(f"type=bind,src={self.flags},dst=/run/drain,readonly", mounts)
        self.assertIn("DRAIN_FLAG_PATH=/run/drain/2-b.drain", args)

    def test_it_listens_on_the_socket_the_router_dials(self):
        self.start()
        args = self.containers()["demo-2-a-sidecar"]
        self.assertIn(f"SOCKET_PATH=/run/sidecar/{hr.SOCKET_NAME}", args)
        self.assertEqual(ds.SOCKET_NAME, hr.SOCKET_NAME)

    def test_a_running_stale_sidecar_is_replaced_not_duplicated(self):
        self.start()
        self.start()
        self.assertEqual(list(self.containers()), ["demo-2-a-sidecar"])
        removals = [c for c in self.calls() if c[:2] == ["rm", "-f"]]
        self.assertEqual(len(removals), 2)

    def test_the_ghost_is_asked_of_the_slots_own_compose_project(self):
        seen = {}

        def run(argv, **kwargs):
            if argv[1:3] == ["compose", "ps"]:
                seen["cwd"] = kwargs.get("cwd")
                seen["argv"] = argv
            return subprocess.run(argv, **kwargs)

        self.start(run=run)
        self.assertEqual(seen["cwd"], self.slot_dir)
        self.assertEqual(seen["argv"][-1], "ghost-a")


class RefusalTests(_Case):
    def assertRefusedWithNothingCreated(self, **kwargs):
        with self.assertRaises(ds.SidecarError):
            self.start(**kwargs)
        self.assertEqual(self.containers(), {})
        self.assertEqual([c for c in self.calls() if c[0] == "run"], [])

    def test_wrong_slot_directory_mode_is_refused(self):
        for mode in (0o755, 0o750, 0o770, 0o777, 0o701, 0o500, 0o600):
            with self.subTest(mode=oct(mode)):
                os.chmod(os.path.join(self.root, "2"), mode)
                self.assertRefusedWithNothingCreated()
        os.chmod(os.path.join(self.root, "2"), 0o700)
        self.start()

    def test_wrong_colour_directory_mode_is_refused(self):
        os.chmod(os.path.join(self.root, "2", "a"), 0o770)
        self.assertRefusedWithNothingCreated()

    def test_wrong_owner_is_refused(self):
        with self.assertRaises(ds.SidecarError):
            ds.verify_colour_dir(self.root, "2", "a", ME + 1)
        with self.assertRaises(ds.SidecarError):
            ds.start("2", "a", env={ds.IMAGE_VARIABLE: DIGEST}, root=self.root, owner_uid=ME + 1,
                     slot_dir=self.slot_dir, flag_dir=self.flags, docker=self.docker)  # fmt: skip
        self.assertEqual(self.containers(), {})

    def test_a_missing_directory_is_refused(self):
        shutil.rmtree(os.path.join(self.root, "2", "a"))
        self.assertRefusedWithNothingCreated()

    def test_a_symlinked_colour_directory_is_refused(self):
        real = os.path.join(self.root, "2", "b")
        shutil.rmtree(os.path.join(self.root, "2", "a"))
        os.symlink(real, os.path.join(self.root, "2", "a"))
        self.assertRefusedWithNothingCreated()

    def test_a_symlinked_slot_directory_is_refused(self):
        real = os.path.join(self.tmp, "elsewhere")
        os.makedirs(os.path.join(real, "a"))
        os.chmod(real, 0o700)
        os.chmod(os.path.join(real, "a"), 0o700)
        shutil.rmtree(os.path.join(self.root, "2"))
        os.symlink(real, os.path.join(self.root, "2"))
        self.assertRefusedWithNothingCreated()

    def test_an_unpinned_image_is_refused(self):
        for bad in (None, "", "ghcr.io/example/drain-sidecar:latest", "name@sha256:abc",
                    DIGEST + "x", "x@sha256:" + "A" * 64, " " + DIGEST, "a b@sha256:" + "a" * 64):  # fmt: skip
            with self.subTest(image=bad):
                env = {} if bad is None else {ds.IMAGE_VARIABLE: bad}
                self.assertRefusedWithNothingCreated(env=env)

    def test_unknown_slot_or_colour_is_refused(self):
        for slot, colour in (("7", "a"), ("2", "c"), ("../2", "a"), ("2", "a/../b")):
            with self.subTest(slot=slot, colour=colour):
                with self.assertRaises(ds.SidecarError):
                    self.start(slot=slot, colour=colour)

    def test_no_running_ghost_is_refused(self):
        for out in ("", "a\nb\n", "not-an-id\n"):
            with self.subTest(out=out), mock.patch.dict(os.environ, {"FAKE_PS_OUT": out}):
                self.assertRefusedWithNothingCreated()

    def test_a_failing_compose_ps_is_refused(self):
        with mock.patch.dict(os.environ, {"FAKE_PS_RC": "1"}):
            self.assertRefusedWithNothingCreated()


class FailedStartTests(_Case):
    def test_a_failed_run_leaves_nothing_running(self):
        with mock.patch.dict(os.environ, {"FAKE_RUN_FAIL": "1"}):
            with self.assertRaises(ds.SidecarError):
                self.start()
        self.assertEqual(self.containers(), {})

    def test_an_interrupted_run_leaves_nothing_running(self):
        def run(argv, **kwargs):
            if argv[1] == "run":
                subprocess.run(argv, **kwargs)
                raise KeyboardInterrupt
            return subprocess.run(argv, **kwargs)

        with self.assertRaises(KeyboardInterrupt):
            self.start(run=run)
        self.assertEqual(self.containers(), {})

    def test_a_timed_out_run_leaves_nothing_running(self):
        def run(argv, **kwargs):
            if argv[1] == "run":
                subprocess.run(argv, **kwargs)
                raise subprocess.TimeoutExpired(argv, 1)
            return subprocess.run(argv, **kwargs)

        with self.assertRaises(ds.SidecarError):
            self.start(run=run)
        self.assertEqual(self.containers(), {})

    def test_the_original_failure_is_reported_even_if_cleanup_also_fails(self):
        with mock.patch.dict(os.environ, {"FAKE_RUN_FAIL": "1"}):
            real = subprocess.run

            def run(argv, **kwargs):
                if argv[1:3] == ["rm", "-f"] and any(c[0] == "run" for c in self.calls()):
                    return subprocess.CompletedProcess(argv, 1, "", "daemon error")
                return real(argv, **kwargs)

            with self.assertRaisesRegex(ds.SidecarError, "docker run failed"):
                self.start(run=run)


class StopTests(_Case):
    def test_stop_removes_a_running_sidecar(self):
        self.start()
        ds.stop("2", "a", docker=self.docker)
        self.assertEqual(self.containers(), {})

    def test_stop_removes_only_this_colours_sidecar(self):
        self.start(colour="a")
        self.start(colour="b")
        ds.stop("2", "a", docker=self.docker)
        self.assertEqual(list(self.containers()), ["demo-2-b-sidecar"])

    def test_stop_of_an_absent_sidecar_succeeds(self):
        ds.stop("2", "a", docker=self.docker)

    def test_stop_that_cannot_remove_a_present_sidecar_fails(self):
        self.start()
        with mock.patch.dict(os.environ, {"FAKE_RM_FAIL": "1"}):
            with self.assertRaises(ds.SidecarError):
                ds.stop("2", "a", docker=self.docker)
        self.assertEqual(list(self.containers()), ["demo-2-a-sidecar"])

    def test_a_missing_docker_binary_is_a_refusal_not_a_traceback(self):
        with self.assertRaises(ds.SidecarError):
            ds.stop("2", "a", docker=os.path.join(self.tmp, "no-such-docker"))


class MainTests(_Case):
    def argv(self, verb, colour="a"):
        return [verb, "2", colour, "--socket-root", self.root, "--owner-uid", str(ME),
                "--slot-dir", self.slot_dir, "--flag-dir", self.flags, "--docker", self.docker]  # fmt: skip

    def test_start_then_stop_exit_zero(self):
        self.assertEqual(ds.main(self.argv("start"), env={ds.IMAGE_VARIABLE: DIGEST}), 0)
        self.assertEqual(list(self.containers()), ["demo-2-a-sidecar"])
        self.assertEqual(ds.main(self.argv("stop")), 0)
        self.assertEqual(self.containers(), {})

    def test_a_refusal_exits_one(self):
        self.assertEqual(ds.main(self.argv("start"), env={}), 1)
        self.assertEqual(self.containers(), {})

    def test_the_image_is_read_from_the_environment_the_unit_provides(self):
        with mock.patch.dict(os.environ, {ds.IMAGE_VARIABLE: DIGEST}):
            self.assertEqual(ds.main(self.argv("start")), 0)
        self.assertEqual(self.containers()["demo-2-a-sidecar"][-1], DIGEST)

    def test_it_runs_as_a_script(self):
        script = str(Path(ds.__file__))
        result = subprocess.run(
            [sys.executable, script, *self.argv("start")],
            env={**os.environ, ds.IMAGE_VARIABLE: DIGEST}, capture_output=True, text=True,
        )  # fmt: skip
        self.assertEqual(result.returncode, 0, result.stderr)


class ContractTests(unittest.TestCase):
    def test_tables_match_the_wrapper_and_the_router(self):
        self.assertEqual(ds.SLOT_NAMES, rss.SLOT_NAMES)
        self.assertEqual(ds.COLOURS, rss.COLOURS)
        self.assertEqual(ds.ROUTER_UID, hr.ROUTER_UID)
        self.assertEqual(ds.SOCKET_ROOT, hr.SOCKET_ROOT)
        self.assertEqual(ds.SOCKET_DIR_MODE, hr.SOCKET_DIR_MODE)
        self.assertEqual(ds.ROUTER_UID, duc.ROUTER_UID)

    def test_provisioner_tables_match_the_router(self):
        self.assertEqual(psd.SLOT_NAMES, rss.SLOT_NAMES)
        self.assertEqual(psd.COLOURS, rss.COLOURS)
        self.assertEqual(psd.ROUTER_USER, hr.ROUTER_USER)
        self.assertEqual(psd.ROUTER_UID, hr.ROUTER_UID)
        self.assertEqual(psd.SOCKET_ROOT, hr.SOCKET_ROOT)
        self.assertEqual(psd.DIR_MODE, hr.SOCKET_DIR_MODE)

    def test_the_flag_directory_and_file_names_are_the_drain_flag_provisioners(self):
        self.assertEqual(ds.FLAG_DIR, dfd.DEFAULT_FLAG_DIR)
        for slot in rss.SLOT_NAMES:
            for colour in rss.COLOURS:
                self.assertEqual(ds.FLAG_FILE.format(slot=slot, colour=colour), dfd.flag_file_name(slot, colour))

    def test_the_slot_directory_is_the_wrappers(self):
        import branchleft_slot as bs

        self.assertEqual(ds.SLOT_DIR, bs.SLOT_DIR)

    def test_the_ghost_port_is_render_cores(self):
        source = (Path(__file__).resolve().parents[2] / "render-core" / "src").glob("*.ts")
        found = [
            m.group(1)
            for f in source
            for m in re.finditer(r"GHOST_CONTAINER_PORT\s*=\s*(\d+)", f.read_text())
        ]
        self.assertEqual(found, [str(ds.GHOST_CONTAINER_PORT)])

    def test_the_sidecar_image_is_never_a_tag(self):
        self.assertIsNone(ds.IMAGE_PATTERN.match("ghcr.io/x/y:1.2.3"))
        self.assertIsNone(ds.IMAGE_PATTERN.match("ghcr.io/x/y"))
        self.assertTrue(ds.IMAGE_PATTERN.match(DIGEST))

    def test_the_script_imports_nothing_from_this_repository(self):
        import ast

        for module in (ds, psd):
            tree = ast.parse(Path(module.__file__).read_text())
            roots = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    roots.update(a.name.split(".")[0] for a in node.names)
                elif isinstance(node, ast.ImportFrom):
                    roots.add((node.module or "").split(".")[0])
            self.assertLessEqual(roots, set(sys.stdlib_module_names), module.__name__)

    def test_no_shell_is_involved(self):
        for module in (ds, psd):
            source = Path(module.__file__).read_text()
            self.assertNotIn("shell=True", source)
            self.assertNotIn("os.system", source)


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pd", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, "demo-router")
        self.chowns: list[tuple] = []

    def run_provision(self, **kwargs):
        return psd.provision(
            self.root, owner=(ME, os.getgid()), root_owner_uid=ME,
            chown=lambda path, uid, gid: self.chowns.append((path, uid, gid)), **kwargs,
        )  # fmt: skip

    def test_creates_every_directory_0700_and_the_root_0755(self):
        created = self.run_provision()
        self.assertEqual(len(created), 1 + 7 + 14)
        self.assertEqual(stat.S_IMODE(os.lstat(self.root).st_mode), 0o755)
        for slot in rss.SLOT_NAMES:
            for sub in (slot, f"{slot}/a", f"{slot}/b"):
                path = os.path.join(self.root, sub)
                self.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), 0o700, path)

    def test_modes_hold_whatever_the_umask(self):
        old = os.umask(0o000)
        self.addCleanup(os.umask, old)
        self.run_provision()
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(self.root, "3", "a")).st_mode), 0o700)

    def test_chowns_each_new_slot_and_colour_directory_to_the_router(self):
        self.run_provision()
        owned = {path for path, uid, _ in self.chowns if uid == ME and path != self.root}
        self.assertIn(os.path.join(self.root, "0", "a"), owned)
        self.assertEqual(len(owned), 7 + 14)

    def test_rerun_is_a_no_op(self):
        self.run_provision()
        self.assertEqual(self.run_provision(), [])

    def test_a_wrong_mode_is_refused_not_corrected(self):
        self.run_provision()
        path = os.path.join(self.root, "4", "b")
        os.chmod(path, 0o750)
        with self.assertRaises(psd.ProvisionError):
            self.run_provision()
        self.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), 0o750)

    def test_every_non_0700_mode_on_a_slot_directory_is_refused(self):
        self.run_provision()
        path = os.path.join(self.root, "1")
        for mode in (0o755, 0o750, 0o770, 0o777, 0o701, 0o500):
            with self.subTest(mode=oct(mode)):
                os.chmod(path, mode)
                with self.assertRaises(psd.ProvisionError):
                    self.run_provision()

    def test_a_wrong_owner_is_refused(self):
        self.run_provision()
        with self.assertRaises(psd.ProvisionError):
            psd.provision(self.root, owner=(ME + 1, os.getgid()), root_owner_uid=ME,
                          chown=lambda *a: None)  # fmt: skip
        self.assertEqual(len(os.listdir(self.root)), 7)

    def test_a_root_owned_by_someone_else_is_refused(self):
        self.run_provision()
        with self.assertRaises(psd.ProvisionError):
            psd.provision(self.root, owner=(ME, os.getgid()), root_owner_uid=ME + 1,
                          chown=lambda *a: None)  # fmt: skip

    def test_a_file_in_place_of_a_directory_is_refused(self):
        os.makedirs(os.path.join(self.root, "0"), mode=0o700)
        os.chmod(self.root, 0o755)
        Path(self.root, "0", "a").write_text("")
        with self.assertRaises(psd.ProvisionError):
            self.run_provision()

    def test_a_symlinked_colour_directory_is_refused(self):
        self.run_provision()
        shutil.rmtree(os.path.join(self.root, "5", "a"))
        os.symlink(os.path.join(self.root, "5", "b"), os.path.join(self.root, "5", "a"))
        with self.assertRaises(psd.ProvisionError):
            self.run_provision()

    def test_a_missing_account_is_refused_with_the_command_to_create_it(self):
        with mock.patch.object(psd.pwd, "getpwnam", side_effect=KeyError):
            with self.assertRaisesRegex(psd.ProvisionError, "useradd --system --uid 30008"):
                psd.resolve_router()

    def test_an_account_with_the_wrong_uid_is_refused(self):
        entry = mock.Mock(pw_uid=1234, pw_gid=1234)
        with mock.patch.object(psd.pwd, "getpwnam", return_value=entry):
            with self.assertRaisesRegex(psd.ProvisionError, "expected 30008"):
                psd.resolve_router()

    def test_main_exit_codes(self):
        with mock.patch.object(psd, "provision", return_value=[]):
            self.assertEqual(psd.main(["--root", self.root]), 0)
        with mock.patch.object(psd, "provision", side_effect=psd.ProvisionError("x")):
            self.assertEqual(psd.main(["--root", self.root]), 1)


if __name__ == "__main__":
    unittest.main()
