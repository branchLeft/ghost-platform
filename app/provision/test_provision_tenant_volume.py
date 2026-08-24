#!/usr/bin/env python3
"""Unit tests for provision_tenant_volume.

This script owns the one runtime-isolation control that fails open: without
it every tenant container still starts, on a volume the Ghost image leaves
world-writable. Its refusals -- a UID another tenant already holds, a UID
change on a provisioned volume, a reserved slug -- are what stand between a
mistyped number and one tenant reading another's content, so they are covered
here rather than left to a live host to discover.

Every `docker` invocation is mocked; no daemon, no network, no root.
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
    def __init__(self, files=None):
        self.files = dict(files or {})
        self.owners: dict[str, tuple[int, int]] = {}
        self.modes: dict[str, int] = {}

    def read_text(self, path):
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path]

    def write_text(self, path, text):
        self.files[path] = text

    def chown(self, path, uid, gid):
        self.owners[path] = (uid, gid)

    def chmod(self, path, mode):
        self.modes[path] = mode


def provision(slug, uid, docker, fs):
    return ptv.provision_tenant_volumes(
        slug,
        uid,
        run=docker,
        read_text=fs.read_text,
        write_text=fs.write_text,
        chown=fs.chown,
        chmod=fs.chmod,
    )


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

    def test_seeds_a_claim_so_dockers_copy_up_never_fires(self):
        # A non-empty volume is never populated from the image path, which is
        # what stops Docker re-applying the image's world-writable content
        # directory over the ownership set above.
        path = f"{self.docker.volumes['ghost-blog-content']}/{ptv.CLAIM_FILE}"
        self.assertEqual(self.fs.files[path], "slug=blog\nuid=30001\n")
        self.assertEqual(self.fs.owners[path], (30001, 30001))
        self.assertEqual(self.fs.modes[path], 0o600)

    def test_reports_what_it_did(self):
        self.assertTrue(any("created volume ghost-blog-content" in a for a in self.actions))


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
        # The claim is recovered from the volume on the host, so a second
        # tenant repo that has never seen the first repo's config is still
        # refused.
        docker = FakeDocker({"ghost-blog-content": "/v/blog"})
        fs = FakeFs({"/v/blog/.branchleft-tenant": "slug=blog\nuid=30007\n"})
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

    def test_an_unreadable_claim_does_not_silently_free_the_slug(self):
        docker = FakeDocker({"ghost-blog-content": "/v/blog"})
        fs = FakeFs()  # no claim file at all
        claims = ptv.existing_claims(run=docker, read_text=fs.read_text)
        self.assertEqual(claims["blog"], -1)
        # Still refused, because the slug is visibly taken at a uid nobody can
        # read -- the state a re-provision must not paper over.
        with self.assertRaises(ptv.ProvisionError):
            provision("blog", 30001, docker, fs)


class FailureTests(unittest.TestCase):
    def test_a_docker_failure_is_an_error_not_a_silent_pass(self):
        docker = FakeDocker(fail_on="volume create")
        with self.assertRaises(ptv.ProvisionError):
            provision("blog", 30001, docker, FakeFs())


if __name__ == "__main__":
    unittest.main()
