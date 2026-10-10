import json
import unittest

from release_watcher import clients

DIGEST = "sha256:db4c56c196d6d5ed8ef9c0e80012792c16c51d4c23adb1683279506f525212b5"


class ScriptedRequest:
    """Answers each (method, url-prefix) from a queue; records every call."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, method="GET", headers=None, body=None):
        self.calls.append((method, url, body))
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

    def test_resolves_the_manifest_digest_from_the_header(self):
        request = ScriptedRequest([
            (200, {}, json.dumps({"token": "x"}).encode()),
            (200, {"docker-content-digest": DIGEST}, b""),
        ])
        digest = clients.DockerHubRegistry(request=request).resolve_digest("6.69.0-alpine")
        self.assertEqual(digest, DIGEST)
        self.assertEqual(request.calls[1][0], "HEAD")

    def test_a_manifest_without_a_digest_header_is_an_error(self):
        request = ScriptedRequest([
            (200, {}, json.dumps({"token": "x"}).encode()),
            (200, {}, b""),
        ])
        with self.assertRaises(RuntimeError):
            clients.DockerHubRegistry(request=request).resolve_digest("6.69.0-alpine")


class GitHubTests(unittest.TestCase):
    def test_create_branch_reports_an_existing_branch_as_false(self):
        request = ScriptedRequest([(422, {}, b'{"message":"Reference already exists"}')])
        api = clients.GitHubApi("branchLeft/ghost-platform", "t", request=request)
        self.assertFalse(api.create_branch("release-watcher/ghost-6.69.0-alpine", "a" * 40))

    def test_a_failed_read_is_an_error_not_an_empty_answer(self):
        request = ScriptedRequest([(500, {}, b"{}")])
        api = clients.GitHubApi("branchLeft/ghost-platform", "t", request=request)
        with self.assertRaises(RuntimeError):
            api.open_pulls_for_branch("branchLeft", "release-watcher/ghost-6.69.0-alpine")


if __name__ == "__main__":
    unittest.main()
