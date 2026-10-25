import json
import unittest

from release_watcher import clients

DIGEST = "sha256:db4c56c196d6d5ed8ef9c0e80012792c16c51d4c23adb1683279506f525212b5"


class ScriptedRequest:
    """Answers each call from a queue; records every call."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, method="GET", headers=None, body=None):
        self.calls.append((method, url, headers, body))
        return self.responses.pop(0)


class RegistryTests(unittest.TestCase):
    def test_lists_tags_across_link_header_pages(self):
        next_link = '</v2/library/ghost/tags/list?last=6.0.0-alpine&n=1000>; rel="next"'
        request = ScriptedRequest([
            (200, {}, json.dumps({"token": "x"}).encode()),
            (200, {"Link": next_link}, json.dumps({"tags": ["6.0.0-alpine"]}).encode()),
            (200, {}, json.dumps({"tags": ["6.1.0-alpine"]}).encode()),
        ])
        tags = clients.DockerHubRegistry(request=request).list_tags()
        self.assertEqual(tags, ["6.0.0-alpine", "6.1.0-alpine"])
        self.assertIn("last=6.0.0-alpine", request.calls[2][1])

    def test_a_link_to_another_host_is_refused_and_never_followed(self):
        next_link = '<https://evil.example/v2/library/ghost/tags/list?last=x&n=1000>; rel="next"'
        request = ScriptedRequest([
            (200, {}, json.dumps({"token": "x"}).encode()),
            (200, {"Link": next_link}, json.dumps({"tags": ["6.0.0"]}).encode()),
        ])
        with self.assertRaises(RuntimeError) as context:
            clients.DockerHubRegistry(request=request).list_tags()
        self.assertIn("evil.example", str(context.exception))
        self.assertEqual(len(request.calls), 2)
        self.assertFalse(any("evil.example" in call[1] for call in request.calls))
        for method, url, headers, body in request.calls:
            self.assertTrue(
                url.startswith(f"{clients.REGISTRY_HOST}/") or url == clients.TOKEN_URL, url
            )
            if not url.startswith(clients.REGISTRY_HOST):
                self.assertNotIn("Authorization", headers or {})

    def test_a_scheme_downgrade_on_the_registry_host_is_refused(self):
        next_link = '<http://registry-1.docker.io/v2/library/ghost/tags/list?last=x&n=1000>; rel="next"'
        request = ScriptedRequest([
            (200, {}, json.dumps({"token": "x"}).encode()),
            (200, {"Link": next_link}, json.dumps({"tags": ["6.0.0"]}).encode()),
        ])
        with self.assertRaises(RuntimeError):
            clients.DockerHubRegistry(request=request).list_tags()
        self.assertEqual(len(request.calls), 2)
        self.assertFalse(any(call[1].startswith("http://") for call in request.calls))

    def test_an_absolute_link_on_the_registry_host_is_followed(self):
        next_link = '<https://registry-1.docker.io/v2/library/ghost/tags/list?last=6.0.0-alpine&n=1000>; rel="next"'
        absolute_url = "https://registry-1.docker.io/v2/library/ghost/tags/list?last=6.0.0-alpine&n=1000"
        request = ScriptedRequest([
            (200, {}, json.dumps({"token": "x"}).encode()),
            (200, {"Link": next_link}, json.dumps({"tags": ["6.0.0-alpine"]}).encode()),
            (200, {}, json.dumps({"tags": ["6.1.0-alpine"]}).encode()),
        ])
        tags = clients.DockerHubRegistry(request=request).list_tags()
        self.assertEqual(tags, ["6.0.0-alpine", "6.1.0-alpine"])
        self.assertEqual(request.calls[2][1], absolute_url)

    def test_a_link_with_userinfo_or_another_port_is_refused(self):
        links = [
            "https://registry-1.docker.io@evil.example/v2/library/ghost/tags/list?last=x&n=1000",
            "https://registry-1.docker.io:8443/v2/library/ghost/tags/list?last=x&n=1000",
        ]
        for link in links:
            with self.subTest(link=link):
                request = ScriptedRequest([
                    (200, {}, json.dumps({"token": "x"}).encode()),
                    (200, {"Link": f'<{link}>; rel="next"'}, json.dumps({"tags": ["6.0.0"]}).encode()),
                ])
                with self.assertRaises(RuntimeError):
                    clients.DockerHubRegistry(request=request).list_tags()
                self.assertEqual(len(request.calls), 2)

    def test_resolves_the_manifest_digest_from_the_header(self):
        request = ScriptedRequest([
            (200, {}, json.dumps({"token": "x"}).encode()),
            (200, {"docker-content-digest": DIGEST}, b""),
        ])
        self.assertEqual(clients.DockerHubRegistry(request=request).resolve_digest("6.69.0-alpine"), DIGEST)
        self.assertEqual(request.calls[1][0], "HEAD")

    def test_a_manifest_without_a_digest_header_is_an_error(self):
        request = ScriptedRequest([(200, {}, json.dumps({"token": "x"}).encode()), (200, {}, b"")])
        with self.assertRaises(RuntimeError):
            clients.DockerHubRegistry(request=request).resolve_digest("6.69.0-alpine")


class GitHubTests(unittest.TestCase):
    REPO = "branchLeft/ghost-platform"
    BRANCH = "release-watcher/ghost-6"

    def api(self, *responses):
        request = ScriptedRequest(list(responses))
        return clients.GitHubApi(self.REPO, "t", request=request), request

    def test_create_branch_returns_true_on_201(self):
        api, _ = self.api((201, {}, b"{}"))
        self.assertTrue(api.create_branch(self.BRANCH, "a" * 40))

    def test_create_branch_treats_only_a_reference_already_exists_422_as_existing(self):
        api, _ = self.api((422, {}, b'{"message":"Reference already exists"}'))
        self.assertFalse(api.create_branch(self.BRANCH, "a" * 40))

    def test_any_other_422_on_create_branch_is_an_error_not_existing(self):
        api, _ = self.api((422, {}, b'{"message":"Object does not exist"}'))
        with self.assertRaises(RuntimeError):
            api.create_branch(self.BRANCH, "a" * 40)

    def test_a_403_on_create_branch_is_an_error(self):
        api, _ = self.api((403, {}, b'{"message":"Resource not accessible"}'))
        with self.assertRaises(RuntimeError):
            api.create_branch(self.BRANCH, "a" * 40)

    def test_read_file_asks_for_the_raw_media_type(self):
        api, request = self.api((200, {}, b"FROM ghost:6.55.0-alpine\n"))
        self.assertEqual(api.read_file("Dockerfile", self.BRANCH), "FROM ghost:6.55.0-alpine\n")
        self.assertEqual(request.calls[0][2]["Accept"], "application/vnd.github.raw+json")

    def test_list_pulls_filters_by_head_owner_and_state(self):
        api, request = self.api((200, {}, b"[]"))
        api.list_pulls(self.BRANCH, "open")
        self.assertIn("state=open&head=branchLeft:release-watcher/ghost-6", request.calls[0][1])

    def test_a_failed_read_is_an_error_not_an_empty_answer(self):
        api, _ = self.api((500, {}, b"{}"))
        with self.assertRaises(RuntimeError):
            api.list_pulls(self.BRANCH, "open")


if __name__ == "__main__":
    unittest.main()
