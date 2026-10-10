"""Registry and GitHub REST clients. Stdlib only; the transport is injectable."""

import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request

REGISTRY_HOST = "https://registry-1.docker.io"
TOKEN_URL = (
    "https://auth.docker.io/token?service=registry.docker.io"
    "&scope=repository:library/ghost:pull"
)
MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
    ]
)
NEXT_LINK = re.compile(r'<([^>]+)>;\s*rel="next"')
TIMEOUT_SECONDS = 30


def _request(url, method="GET", headers=None, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


class DockerHubRegistry:
    """Anonymous pull access to the public library/ghost repository."""

    def __init__(self, request=_request):
        self._request = request
        self._token = None

    def _bearer(self):
        if self._token is None:
            status, _headers, body = self._request(TOKEN_URL)
            if status != 200:
                raise RuntimeError(f"registry token request failed: HTTP {status}")
            self._token = json.loads(body)["token"]
        return {"Authorization": f"Bearer {self._token}"}

    def list_tags(self):
        tags = []
        url = f"{REGISTRY_HOST}/v2/library/ghost/tags/list?n=1000"
        while url:
            status, headers, body = self._request(url, headers=self._bearer())
            if status != 200:
                raise RuntimeError(f"tag list failed: HTTP {status}")
            tags.extend(json.loads(body).get("tags") or [])
            url = _next_page_url(headers)
        return tags

    def resolve_digest(self, tag):
        url = f"{REGISTRY_HOST}/v2/library/ghost/manifests/{tag}"
        headers = dict(self._bearer(), Accept=MANIFEST_ACCEPT)
        status, response_headers, _body = self._request(url, method="HEAD", headers=headers)
        if status != 200:
            raise RuntimeError(f"manifest lookup for {tag} failed: HTTP {status}")
        digest = _header(response_headers, "docker-content-digest")
        if digest is None:
            raise RuntimeError(f"manifest for {tag} carried no Docker-Content-Digest")
        return digest


def _header(headers, name):
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None


def _next_page_url(headers):
    link = _header(headers, "link")
    if not link:
        return None
    match = NEXT_LINK.search(link)
    if match is None:
        return None
    return urllib.parse.urljoin(REGISTRY_HOST, match.group(1))


class GitHubApi:
    """The few REST calls the watcher needs, authenticated with one token."""

    API = "https://api.github.com"

    def __init__(self, repo, token, request=_request):
        self._repo = repo
        self._request = request
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _call(self, method, path, body=None, ok=(200, 201)):
        status, _headers, raw = self._request(
            f"{self.API}/repos/{self._repo}/{path}",
            method=method,
            headers=self._headers,
            body=body,
        )
        if status not in ok:
            raise RuntimeError(f"GitHub {method} {path} failed: HTTP {status}")
        return json.loads(raw) if raw else {}

    def open_pulls_for_branch(self, owner, branch):
        return self._call("GET", f"pulls?state=open&head={owner}:{branch}")

    def create_branch(self, branch, sha):
        """Returns False when the branch already exists, so the caller can stop."""
        status, _headers, _raw = self._request(
            f"{self.API}/repos/{self._repo}/git/refs",
            method="POST",
            headers=self._headers,
            body={"ref": f"refs/heads/{branch}", "sha": sha},
        )
        if status == 422:
            return False
        if status != 201:
            raise RuntimeError(f"GitHub create branch failed: HTTP {status}")
        return True

    def file_blob_sha(self, path, ref):
        return self._call("GET", f"contents/{path}?ref={ref}")["sha"]

    def commit_file(self, path, branch, blob_sha, text, message):
        """A contents-API commit. GitHub signs commits made this way."""
        return self._call(
            "PUT",
            f"contents/{path}",
            body={
                "message": message,
                "content": base64.b64encode(text.encode()).decode(),
                "branch": branch,
                "sha": blob_sha,
            },
        )

    def open_pull(self, branch, base, title, body):
        return self._call(
            "POST",
            "pulls",
            body={"title": title, "head": branch, "base": base, "body": body},
        )
