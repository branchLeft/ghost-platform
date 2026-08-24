#!/usr/bin/env python3
"""Unit tests for provision_tenant_volume.

This script owns the one runtime-isolation control that fails open: without
it every tenant container still starts, on a volume the Ghost image leaves
world-writable. Its refusals -- a UID another tenant already holds, a UID
change on a provisioned volume, a reserved slug, an allocation it cannot
establish -- are what stand between a mistyped number and one tenant reading
another's content, so they are covered here rather than left to a live host to
discover.

The UID-freeing case has its own tests, in both directions. An earlier form of
this script kept the claim inside the tenant's own `0700` content volume, where
the tenant could unlink it; a missing claim then read as "unclaimed", and
because a missing claim never compares equal to a real UID, a second tenant was
accepted onto the same number. Asserting that the *slug* is not freed did not
catch it -- the UID is the thing that has to stay claimed.

Every `docker` invocation and every filesystem call is mocked; no daemon, no
network, no root.
"""

from __future__ import annotations

import unittest

import provision_tenant_volume as ptv


class FakeDocker:
    """Stands in for `subprocess.run` against the `docker` CLI.

    `volumes` is the host's state: volume name -> mountpoint.
    """

    def __init__(self, volumes=None, fail_on=None):
        self.volumes = dict(volumes or {})
        self.fail_on = fail_on
        self.calls: list[list[str]] = []

    def __call__(self, argv, capture_output=None, text=None, check=None):
        self.calls.append(argv)
        args = argv[1:]

        if self.fail_on and self.fail_on in " ".join(args):
            return _Result(1, "", "docker refused")

        if args[:3] == ["volume", "ls", "--quiet"]:
            if "--filter" in args:
                wanted = args[args.index("--filter") + 1].removeprefix("name=^").removesuffix("$")
                names = [name for name in self.volumes if name == wanted]
            else:
                names = list(self.volumes)
            return _Result(0, "".join(f"{name}\n" for name in names), "")

        if args[:2] == ["volume", "inspect"]:
            name = args[2]
            if name not in self.volumes:
                return _Result(1, "", f"no such volume: {name}")
            return _Result(0, f'"{self.volumes[name]}"\n', "")

        if args[:2] == ["volume", "create"]:
            name = args[2]
            self.volumes[name] = f"/var/lib/docker/volumes/{name}/_data"
            return _Result(0, f"{name}\n", "")

        raise AssertionError(f"unexpected docker call: {argv}")


class _Result:
    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeFs:
    """An in-memory stand-in for the script's filesystem operations."""

    def __init__(self, files=None, dirs=None):
        self.files: dict[str, str] = dict(files or {})
        self.dirs: set[str] = set(dirs or [])
        self.owners: dict[str, tuple[int, int]] = {}
        self.modes: dict[str, int] = {}
        self.write_modes: dict[str, int] = {}

    def listdir(self, path):
        if path not in self.dirs:
            return []
        prefix = path.rstrip("/") + "/"
        return [name[len(prefix) :] for name in self.files if name.startswith(prefix)]

    def read_text(self, path):
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path]

    def write_text(self, path, text, mode):
        self.files[path] = text
        self.write_modes[path] = mode

    def makedirs(self, path, mode):
        self.dirs.add(path)
        self.modes[path] = mode

    def chown(self, path, uid, gid):
        self.owners[path] = (uid, gid)

    def chmod(self, path, mode):
        self.modes[path] = mode


CLAIMS = "/etc/branchleft/tenant-uids"


def provision(slug, uid, docker, fs):
    return ptv.provision_tenant_volumes(slug, uid, run=docker, claim_dir=CLAIMS, fs=fs)


class ValidationTests(unittest.TestCase):
    def test_rejects_a_slug_the_component_would_also_reject(self):
        for slug in ("1blog", "Blog", "blog_one", "blog one", "", "blog/../website"):
            with self.subTest(slug=slug):
                with self.assertRaises(ptv.ProvisionError):
                    ptv.validate_slug(slug)

    def test_rejects_a_reserved_stack_name(self):
        # `website` already runs under /opt/branchleft/website on app1.
        for slug in ptv.RESERVED_STACK_NAMES:
            with self.subTest(slug=slug):
                with self.assertRaises(ptv.ProvisionError):
                    ptv.validate_slug(slug)

    def test_rejects_a_uid_outside_the_reserved_range(self):
        for uid in (0, 999, ptv.TENANT_UID_MIN - 1, ptv.TENANT_UID_MAX + 1):
            with self.subTest(uid=uid):
                with self.assertRaises(ptv.ProvisionError):
                    ptv.validate_uid(uid)

    def test_volume_names_match_the_component(self):
        # infra/tenant/naming.ts derives the same two strings; a disagreement
        # here produces a stack whose external volumes do not exist.
        self.assertEqual(ptv.content_volume_name("blog"), "ghost-blog-content")
        self.assertEqual(ptv.adapters_volume_name("blog"), "ghost-blog-adapters")


class ClaimParsingTests(unittest.TestCase):
    def test_round_trips(self):
        self.assertEqual(ptv.parse_claim(ptv.render_claim("blog", 30001)), ("blog", 30001))

    def test_refuses_an_unreadable_claim_rather_than_guessing(self):
        for text in ("", "slug=blog\n", "uid=30001\n", "nonsense\n", "slug=blog\nuid=x\n"):
            with self.subTest(text=text):
                with self.assertRaises(ptv.ProvisionError):
                    ptv.parse_claim(text)


class FirstProvisionTests(unittest.TestCase):
    def setUp(self):
        self.docker = FakeDocker()
        self.fs = FakeFs()
        self.actions = provision("blog", 30001, self.docker, self.fs)

    def test_creates_both_volumes(self):
        self.assertIn("ghost-blog-content", self.docker.volumes)
        self.assertIn("ghost-blog-adapters", self.docker.volumes)

    def test_owns_the_content_volume_to_the_tenant_uid_at_0700(self):
        path = self.docker.volumes["ghost-blog-content"]
        self.assertEqual(self.fs.owners[path], (30001, 30001))
        self.assertEqual(self.fs.modes[path], 0o700)

    def test_leaves_the_adapters_volume_unwritable_by_the_tenant(self):
        # Ghost `require()`s JavaScript out of this path; writable, an
        # arbitrary-file-write bug becomes Node execution at the next restart.
        path = self.docker.volumes["ghost-blog-adapters"]
        self.assertEqual(self.fs.owners[path], (0, 0))
        self.assertEqual(self.fs.modes[path], 0o555)

    def test_seeds_the_volume_so_dockers_copy_up_never_fires(self):
        # A non-empty volume is never populated from the image path, which is
        # what stops Docker re-applying the image's world-writable content
        # directory over the ownership set above.
        path = f"{self.docker.volumes['ghost-blog-content']}/{ptv.SEED_FILE}"
        self.assertIn(path, self.fs.files)

    def test_writes_the_claim_where_the_tenant_cannot_reach_it(self):
        # Not in the content volume: unlink is governed by the containing
        # directory, and the tenant owns that one.
        entry = f"{CLAIMS}/blog"
        self.assertEqual(self.fs.files[entry], "slug=blog\nuid=30001\n")
        self.assertEqual(self.fs.owners[entry], (0, 0))
        self.assertEqual(self.fs.modes[entry], 0o600)
        self.assertEqual(self.fs.owners[CLAIMS], (0, 0))
        self.assertEqual(self.fs.modes[CLAIMS], 0o700)

    def test_the_claim_is_not_inside_the_content_volume(self):
        content = self.docker.volumes["ghost-blog-content"]
        for path, text in self.fs.files.items():
            if path.startswith(content):
                self.assertNotIn("uid=", text)

    def test_reports_what_it_did(self):
        self.assertTrue(any("created volume ghost-blog-content" in a for a in self.actions))
        self.assertTrue(any("claimed uid 30001" in a for a in self.actions))


class IdempotencyTests(unittest.TestCase):
    def test_a_second_run_with_the_same_uid_changes_nothing_material(self):
        docker, fs = FakeDocker(), FakeFs()
        provision("blog", 30001, docker, fs)
        before = dict(fs.files)
        actions = provision("blog", 30001, docker, fs)
        self.assertEqual(fs.files, before)
        self.assertTrue(any("already existed" in a for a in actions))


class UidCollisionTests(unittest.TestCase):
    def test_refuses_a_uid_another_tenant_already_holds(self):
        docker, fs = FakeDocker(), FakeFs()
        provision("blog", 30001, docker, fs)
        with self.assertRaises(ptv.ProvisionError) as caught:
            provision("news", 30001, docker, fs)
        self.assertIn("already claimed", str(caught.exception))

    def test_the_check_reads_the_host_not_an_argument(self):
        # The claim is recovered from the host's own register, so a second
        # tenant repo that has never seen the first repo's config is still
        # refused.
        docker = FakeDocker({"ghost-blog-content": "/v/blog"})
        fs = FakeFs(files={f"{CLAIMS}/blog": "slug=blog\nuid=30007\n"}, dirs={CLAIMS})
        with self.assertRaises(ptv.ProvisionError):
            provision("news", 30007, docker, fs)

    def test_allows_a_free_uid_alongside_an_existing_tenant(self):
        docker, fs = FakeDocker(), FakeFs()
        provision("blog", 30001, docker, fs)
        provision("news", 30002, docker, fs)
        self.assertIn("ghost-news-content", docker.volumes)

    def test_refuses_changing_a_provisioned_tenants_uid(self):
        # The content is 0700 to the old uid; re-owning it is a migration with
        # a copy step, not a re-run.
        docker, fs = FakeDocker(), FakeFs()
        provision("blog", 30001, docker, fs)
        with self.assertRaises(ptv.ProvisionError) as caught:
            provision("blog", 30002, docker, fs)
        self.assertIn("already holds uid 30001", str(caught.exception))


class DeletedClaimTests(unittest.TestCase):
    """The regression that a slug-only assertion did not catch."""

    def setUp(self):
        self.docker, self.fs = FakeDocker(), FakeFs()
        provision("blog", 30001, self.docker, self.fs)
        # Whatever the tenant can reach inside its own volume, gone.
        content = self.docker.volumes["ghost-blog-content"]
        for path in [p for p in self.fs.files if p.startswith(content)]:
            del self.fs.files[path]

    def test_a_tenant_emptying_its_own_volume_does_not_free_its_uid(self):
        with self.assertRaises(ptv.ProvisionError) as caught:
            provision("news", 30001, self.docker, self.fs)
        self.assertIn("already claimed", str(caught.exception))

    def test_nor_does_it_free_the_slug(self):
        with self.assertRaises(ptv.ProvisionError):
            provision("blog", 30002, self.docker, self.fs)

    def test_the_register_still_reports_the_uid(self):
        claims = ptv.existing_claims(run=self.docker, claim_dir=CLAIMS, fs=self.fs)
        self.assertEqual(claims, {"blog": 30001})


class UnestablishableAllocationTests(unittest.TestCase):
    def test_a_volume_with_no_register_entry_is_a_refusal_not_a_free_uid(self):
        # The state a host provisioned before the register existed is in, and
        # the state a wiped register leaves. Reporting it as free is what would
        # hand two tenants one UID.
        docker = FakeDocker({"ghost-blog-content": "/v/blog"})
        fs = FakeFs()
        with self.assertRaises(ptv.ProvisionError) as caught:
            ptv.existing_claims(run=docker, claim_dir=CLAIMS, fs=fs)
        self.assertIn("no entry in", str(caught.exception))

    def test_an_unreadable_register_entry_is_a_refusal(self):
        docker = FakeDocker({"ghost-blog-content": "/v/blog"})
        fs = FakeFs(files={f"{CLAIMS}/blog": "corrupt\n"}, dirs={CLAIMS})
        with self.assertRaises(ptv.ProvisionError):
            ptv.existing_claims(run=docker, claim_dir=CLAIMS, fs=fs)

    def test_a_claim_whose_filename_and_content_disagree_is_a_refusal(self):
        docker = FakeDocker()
        fs = FakeFs(files={f"{CLAIMS}/blog": "slug=news\nuid=30001\n"}, dirs={CLAIMS})
        with self.assertRaises(ptv.ProvisionError) as caught:
            ptv.existing_claims(run=docker, claim_dir=CLAIMS, fs=fs)
        self.assertIn("disagreeing", str(caught.exception))


class FailureTests(unittest.TestCase):
    def test_a_docker_failure_is_an_error_not_a_silent_pass(self):
        docker = FakeDocker(fail_on="volume create")
        with self.assertRaises(ptv.ProvisionError):
            provision("blog", 30001, docker, FakeFs())


class MainTests(unittest.TestCase):
    def run_main(self, argv, *, euid=0, docker=None, fs=None):
        lines: list[str] = []
        code = ptv.main(
            argv,
            geteuid=lambda: euid,
            run=docker or FakeDocker(),
            fs=fs or FakeFs(),
            out=lines.append,
        )
        return code, lines

    def test_refuses_to_run_as_a_non_root_user(self):
        code, _ = self.run_main(["blog", "--uid", "30001"], euid=1000)
        self.assertEqual(code, 1)

    def test_provisions_and_reports(self):
        docker, fs = FakeDocker(), FakeFs()
        code, lines = self.run_main(["blog", "--uid", "30001"], docker=docker, fs=fs)
        self.assertEqual(code, 0)
        self.assertTrue(any("claimed uid 30001" in line for line in lines))

    def test_list_claims_needs_neither_a_slug_nor_a_uid(self):
        # The whole point of asking is not knowing which UIDs are taken.
        docker = FakeDocker({"ghost-blog-content": "/v/blog"})
        fs = FakeFs(files={f"{CLAIMS}/blog": "slug=blog\nuid=30001\n"}, dirs={CLAIMS})
        code, lines = self.run_main(["--list-claims"], docker=docker, fs=fs)
        self.assertEqual(code, 0)
        self.assertEqual(lines, ["blog=30001"])

    def test_list_claims_rejects_a_slug_or_uid_rather_than_ignoring_it(self):
        for argv in (["blog", "--list-claims"], ["--list-claims", "--uid", "30001"]):
            with self.subTest(argv=argv):
                code, _ = self.run_main(argv)
                self.assertEqual(code, 1)

    def test_a_missing_uid_is_an_error_not_a_default(self):
        code, _ = self.run_main(["blog"])
        self.assertEqual(code, 1)

    def test_a_refusal_becomes_a_non_zero_exit(self):
        docker, fs = FakeDocker(), FakeFs()
        self.run_main(["blog", "--uid", "30001"], docker=docker, fs=fs)
        code, _ = self.run_main(["news", "--uid", "30001"], docker=docker, fs=fs)
        self.assertEqual(code, 1)


class NoFollowTests(unittest.TestCase):
    def test_the_real_writer_refuses_to_follow_a_symlink(self):
        # The seed file is created inside a directory the tenant owns, so a
        # symlink planted at that path would otherwise be followed by a
        # root-run write.
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "target")
            link = os.path.join(tmp, "link")
            os.symlink(target, link)
            with self.assertRaises(OSError):
                ptv._RealFs().write_text(link, "x", 0o600)
            self.assertFalse(os.path.exists(target))


if __name__ == "__main__":
    unittest.main()
