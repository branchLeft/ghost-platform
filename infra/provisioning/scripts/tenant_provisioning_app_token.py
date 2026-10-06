#!/usr/bin/env python3
"""Mint, check and revoke the GitHub App installation token that
provision-tenant.yml writes to generated tenant repositories with.

Fails closed: any problem minting, or a grant that differs from the named
permissions in either direction, stops the run before anything is created.
The token is never printed except as a masked workflow output.
See tenant_provisioning_app_token.md#module-overview.
"""

from __future__ import annotations

import argparse
import base64
import calendar
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

API_ROOT = "https://api.github.com"
ACCEPT = "application/vnd.github+json"
API_VERSION = "2022-11-28"
HTTP_TIMEOUT_SECONDS = 20

# Backdated against clock skew; the span to `exp` stays inside GitHub's ten
# minute ceiling.
JWT_BACKDATE_SECONDS = 60
JWT_LIFETIME_SECONDS = 8 * 60

# GitHub issues installation tokens for an hour. A response claiming longer
# is not one this code understands, so it is refused rather than trusted.
MAX_TOKEN_LIFETIME_SECONDS = 3600 + 120

# Exactly what provision-tenant.yml does with this token, and nothing else.
# See tenant_provisioning_app_token.md#required_permissions.
REQUIRED_PERMISSIONS = {
    "administration": "write",
    "contents": "write",
    "environments": "write",
    "metadata": "read",
    "pull_requests": "write",
    "secrets": "write",
    "variables": "write",
    "workflows": "write",
}

APP_ID_ENV = "TENANT_PROVISIONING_APP_ID"
PRIVATE_KEY_ENV = "TENANT_PROVISIONING_APP_PRIVATE_KEY"


class TokenError(Exception):
    """Carries a message safe to print: never key material, never a token."""


def permission_problems(granted):
    """Every way `granted` differs from REQUIRED_PERMISSIONS, as readable
    strings. Empty means an exact match. Extra permissions are refused as
    firmly as missing ones: a token wider than the named set is the failure
    this check exists for."""
    if not isinstance(granted, dict):
        return ["the response carried no permissions mapping"]
    problems = []
    extra = sorted(set(granted) - set(REQUIRED_PERMISSIONS))
    if extra:
        problems.append("extra permission(s) " + ", ".join(
            "%s:%s" % (name, granted[name]) for name in extra))
    missing = sorted(set(REQUIRED_PERMISSIONS) - set(granted))
    if missing:
        problems.append("missing permission(s) " + ", ".join(missing))
    for name in sorted(set(granted) & set(REQUIRED_PERMISSIONS)):
        if granted[name] != REQUIRED_PERMISSIONS[name]:
            problems.append("%s is %s, not %s" % (
                name, granted[name], REQUIRED_PERMISSIONS[name]))
    return problems


_LEVEL_RANK = {"read": 1, "write": 2, "admin": 3}


def permission_shortfalls(have):
    """Each permission the installation lacks or holds at too low a level, as
    `name: have -> need`. Extra and higher-level grants are not shortfalls:
    the mint requests exactly REQUIRED_PERMISSIONS, so GitHub narrows them.
    Returns None when `have` is not a mapping, since nothing is then known."""
    if not isinstance(have, dict):
        return None
    shortfalls = []
    for name in sorted(REQUIRED_PERMISSIONS):
        need = REQUIRED_PERMISSIONS[name]
        held = have.get(name)
        if not isinstance(held, str) or not held:
            held = "none"
        if _LEVEL_RANK.get(held, 0) < _LEVEL_RANK[need]:
            shortfalls.append("%s: %s -> %s" % (name, held, need))
    return shortfalls


def _installation_summary(have):
    """Why a refused mint is or is not explained by the installation."""
    shortfalls = permission_shortfalls(have)
    if shortfalls is None:
        return "The installation reported no permissions to compare."
    if shortfalls:
        return "The installation lacks (have -> need): %s." % "; ".join(shortfalls)
    return ("The installation grants every named permission, so the cause "
            "is not a missing one.")


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def openssl_signer(pem, run=None):
    """A `sign(data) -> bytes` backed by `openssl`, the only RSA available to
    a standard-library script. The key is written to a fresh 0600 file that
    is removed afterwards, the signing input travels on stdin, and openssl's
    stderr is dropped rather than quoted."""
    runner = subprocess.run if run is None else run

    def sign(data):
        fd, path = tempfile.mkstemp(prefix="tenant-app-key-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(pem)
            os.chmod(path, 0o600)
            try:
                proc = runner(
                    ["openssl", "dgst", "-sha256", "-sign", path],
                    input=data,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            except OSError:
                raise TokenError("cannot run openssl to sign the App JWT")
            if proc.returncode != 0 or not proc.stdout:
                raise TokenError(
                    "openssl could not sign with the configured private key "
                    "(exit %s)" % proc.returncode)
            return proc.stdout
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    return sign


def build_jwt(app_id, sign, now):
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64url(json.dumps({
        "iat": int(now) - JWT_BACKDATE_SECONDS,
        "exp": int(now) + JWT_LIFETIME_SECONDS,
        "iss": str(app_id),
    }).encode())
    signing_input = ("%s.%s" % (header, claims)).encode("ascii")
    return "%s.%s" % (signing_input.decode("ascii"), _b64url(sign(signing_input)))


def http_request(method, url, headers, body=None):
    """`(status, parsed JSON or None)`. A transport failure is a TokenError;
    a non-2xx answer is returned for the caller to judge."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    except (urllib.error.URLError, OSError):
        raise TokenError("could not reach the GitHub API")
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, None


def _headers(bearer):
    return {
        "Authorization": "Bearer %s" % bearer,
        "Accept": ACCEPT,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "branchleft-tenant-provisioning",
    }


def _github_message(payload):
    message = payload.get("message") if isinstance(payload, dict) else None
    return message[:200] if isinstance(message, str) else "no message"


def _parse_expiry(value):
    try:
        return calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        raise TokenError("the token response carried no readable expires_at")


def mint_token(app_id, pem, org, http=http_request, sign=None, now=None):
    """Exchange the App's key for an installation token holding exactly
    REQUIRED_PERMISSIONS. Returns the token string, or raises TokenError."""
    if not str(app_id or "").strip():
        raise TokenError("%s is empty or unset" % APP_ID_ENV)
    if not (pem or "").strip():
        raise TokenError(
            "%s is empty or unset; it must be an environment secret on the "
            "tenant-provisioning environment" % PRIVATE_KEY_ENV)
    if not org:
        raise TokenError("no organisation to find the App installation in")
    clock = time.time() if now is None else now
    signer = sign or openssl_signer(pem)
    jwt = build_jwt(app_id, signer, clock)

    status, installation = http(
        "GET", "%s/orgs/%s/installation" % (API_ROOT, org), _headers(jwt))
    if status != 200 or not isinstance(installation, dict):
        raise TokenError(
            "could not find the App's installation on %s (HTTP %s: %s)"
            % (org, status, _github_message(installation)))
    installation_id = installation.get("id")
    if not isinstance(installation_id, int) or isinstance(installation_id, bool):
        raise TokenError("the installation response carried no integer id")

    shortfalls = permission_shortfalls(installation.get("permissions"))
    if shortfalls:
        raise TokenError(
            "the App's installation on %s does not grant what the run needs "
            "(have -> need): %s. Add these on the installation's settings "
            "page and accept the permission request, then run again"
            % (org, "; ".join(shortfalls)))

    status, minted = http(
        "POST",
        "%s/app/installations/%d/access_tokens" % (API_ROOT, installation_id),
        _headers(jwt),
        {"permissions": dict(REQUIRED_PERMISSIONS)},
    )
    if status != 201 or not isinstance(minted, dict):
        raise TokenError(
            "GitHub refused to mint an installation token (HTTP %s: %s). %s"
            % (status, _github_message(minted),
               _installation_summary(installation.get("permissions"))))

    token = minted.get("token")
    if not isinstance(token, str) or not token.strip():
        raise TokenError("the mint response carried no token")

    problems = permission_problems(minted.get("permissions"))
    if problems:
        raise TokenError(
            "the minted token does not hold exactly the named permissions: "
            + "; ".join(problems))

    expires = _parse_expiry(minted.get("expires_at"))
    if not clock < expires <= clock + MAX_TOKEN_LIFETIME_SECONDS:
        raise TokenError("the minted token's expiry is not a short-lived one")
    return token


def revoke_token(token, http=http_request):
    """Best effort: expiry bounds the token anyway. Returns True on success."""
    if not (token or "").strip():
        return False
    try:
        status, _ = http("DELETE", API_ROOT + "/installation/token", _headers(token))
    except TokenError:
        return False
    return status == 204


def _write_output(path, name, value):
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("%s=%s\n" % (name, value))


def run_mint(environ, out, err, http=http_request, sign=None):
    output_path = environ.get("GITHUB_OUTPUT")
    try:
        if not output_path:
            raise TokenError("GITHUB_OUTPUT is not set")
        token = mint_token(
            environ.get(APP_ID_ENV), environ.get(PRIVATE_KEY_ENV),
            environ.get("GITHUB_REPOSITORY_OWNER"), http=http, sign=sign)
    except TokenError as exc:
        print("::error::tenant provisioning token not minted: %s. Refusing "
              "before creating anything; there is no fallback credential."
              % exc, file=err)
        return 1
    print("::add-mask::%s" % token, file=out)
    _write_output(output_path, "token", token)
    print("Minted a short-lived installation token holding exactly: "
          + ", ".join("%s:%s" % pair for pair in sorted(REQUIRED_PERMISSIONS.items())),
          file=out)
    return 0


def run_revoke(environ, out, err, http=http_request):
    token = environ.get("GH_TOKEN", "")
    if not token.strip():
        print("No provisioning token was minted, nothing to revoke.", file=out)
        return 0
    if revoke_token(token, http=http):
        print("Revoked the provisioning installation token.", file=out)
    else:
        print("::warning::could not revoke the provisioning installation "
              "token; it expires within the hour.", file=err)
    return 0


def main(argv, environ=None, out=None, err=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("command", choices=("mint", "revoke"))
    args = parser.parse_args(argv)
    env = os.environ if environ is None else environ
    out = sys.stdout if out is None else out
    err = sys.stderr if err is None else err
    if args.command == "mint":
        return run_mint(env, out, err)
    return run_revoke(env, out, err)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
