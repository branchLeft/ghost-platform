#!/usr/bin/env python3
"""Unit tests for tenant_provisioning_app_token.py, the minting, permission
check and revocation behind provision-tenant.yml's credential. Every network
call is a fake; the one real dependency exercised is openssl, which signs a
JWT that is then verified against the matching public key.
"""

from __future__ import annotations

import base64
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import tenant_provisioning_app_token as app_token  # noqa: E402

NOW = 1_800_000_000
PEM = "-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n"
ORG = "branchLeft"


def _iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _fake_sign(data):
    return b"signature"


class FakeApi:
    """Records every call and answers the two mint endpoints. Each answer is
    overridable so a test can break exactly one thing."""

    def __init__(self, installation=(200, {"id": 42}), minted=None):
        self.calls = []
        self.installation = installation
        self.minted = minted if minted is not None else (
            201,
            {
                "token": "ghs_FAKETOKEN",
                "permissions": dict(app_token.REQUIRED_PERMISSIONS),
                "expires_at": _iso(NOW + 3600),
            },
        )

    def __call__(self, method, url, headers, body=None):
        self.calls.append((method, url, headers, body))
        if url.endswith("/installation"):
            return self.installation
        if url.endswith("/access_tokens"):
            return self.minted
        return 404, None


def _minted_with(**overrides):
    payload = {
        "token": "ghs_FAKETOKEN",
        "permissions": dict(app_token.REQUIRED_PERMISSIONS),
        "expires_at": _iso(NOW + 3600),
    }
    payload.update(overrides)
    return 201, payload


def _mint(api=None, app_id="123", pem=PEM, org=ORG):
    return app_token.mint_token(
        app_id, pem, org, http=api or FakeApi(), sign=_fake_sign, now=NOW)


class PermissionProblemsTests(unittest.TestCase):
    def test_the_exact_set_has_no_problems(self):
        self.assertEqual(
            app_token.permission_problems(dict(app_token.REQUIRED_PERMISSIONS)), [])

    def test_an_extra_permission_is_refused(self):
        granted = dict(app_token.REQUIRED_PERMISSIONS, members="write")
        problems = app_token.permission_problems(granted)
        self.assertEqual(len(problems), 1)
        self.assertIn("extra permission(s) members:write", problems[0])

    def test_an_extra_read_permission_is_still_extra(self):
        granted = dict(app_token.REQUIRED_PERMISSIONS, issues="read")
        self.assertTrue(app_token.permission_problems(granted))

    def test_a_missing_permission_is_refused(self):
        granted = dict(app_token.REQUIRED_PERMISSIONS)
        del granted["workflows"]
        problems = app_token.permission_problems(granted)
        self.assertIn("missing permission(s) workflows", problems[0])

    def test_a_downgraded_level_is_refused(self):
        granted = dict(app_token.REQUIRED_PERMISSIONS, secrets="read")
        self.assertIn("secrets is read, not write",
                      app_token.permission_problems(granted)[0])

    def test_an_upgraded_level_is_refused(self):
        granted = dict(app_token.REQUIRED_PERMISSIONS, metadata="write")
        self.assertIn("metadata is write, not read",
                      app_token.permission_problems(granted)[0])

    def test_extra_and_missing_are_both_reported(self):
        granted = dict(app_token.REQUIRED_PERMISSIONS, members="write")
        del granted["variables"]
        self.assertEqual(len(app_token.permission_problems(granted)), 2)

    def test_a_non_mapping_is_refused(self):
        for value in (None, [], "repo", 7):
            self.assertTrue(app_token.permission_problems(value), value)

    def test_the_named_set_is_what_the_workflow_needs_and_no_more(self):
        self.assertEqual(
            app_token.REQUIRED_PERMISSIONS,
            {
                "administration": "write",
                "contents": "write",
                "environments": "write",
                "metadata": "read",
                "pull_requests": "write",
                "secrets": "write",
                "variables": "write",
                "workflows": "write",
            },
        )


class MintTokenTests(unittest.TestCase):
    def test_returns_the_token_when_the_grant_is_exact(self):
        self.assertEqual(_mint(), "ghs_FAKETOKEN")

    def test_requests_exactly_the_named_permissions(self):
        api = FakeApi()
        _mint(api)
        method, url, _, body = api.calls[-1]
        self.assertEqual(method, "POST")
        self.assertTrue(url.endswith("/app/installations/42/access_tokens"))
        self.assertEqual(body, {"permissions": app_token.REQUIRED_PERMISSIONS})

    def test_looks_the_installation_up_on_the_organisation(self):
        api = FakeApi()
        _mint(api)
        self.assertEqual(api.calls[0][0:2],
                         ("GET", app_token.API_ROOT + "/orgs/branchLeft/installation"))

    def test_both_calls_carry_a_bearer_jwt(self):
        api = FakeApi()
        _mint(api)
        for _, _, headers, _ in api.calls:
            self.assertTrue(headers["Authorization"].startswith("Bearer "))
            self.assertEqual(headers["Authorization"].count("."), 2)

    def test_refuses_a_token_wider_than_requested(self):
        wide = dict(app_token.REQUIRED_PERMISSIONS, members="write")
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(FakeApi(minted=_minted_with(permissions=wide)))
        self.assertIn("extra permission(s) members:write", str(ctx.exception))

    def test_refuses_a_token_narrower_than_requested(self):
        narrow = dict(app_token.REQUIRED_PERMISSIONS)
        del narrow["administration"]
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(FakeApi(minted=_minted_with(permissions=narrow)))
        self.assertIn("administration", str(ctx.exception))

    def test_refuses_a_response_with_no_permissions(self):
        with self.assertRaises(app_token.TokenError):
            _mint(FakeApi(minted=_minted_with(permissions=None)))

    def test_refuses_an_empty_or_missing_token(self):
        for token in ("", "  ", None, 5):
            with self.assertRaises(app_token.TokenError, msg=repr(token)):
                _mint(FakeApi(minted=_minted_with(token=token)))

    def test_refuses_when_the_mint_is_refused(self):
        api = FakeApi(minted=(422, {"message": "permissions not granted"}))
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(api)
        self.assertIn("HTTP 422", str(ctx.exception))
        self.assertIn("permissions not granted", str(ctx.exception))

    def test_refuses_a_201_without_a_json_object(self):
        with self.assertRaises(app_token.TokenError):
            _mint(FakeApi(minted=(201, None)))

    def test_refuses_when_there_is_no_installation(self):
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(FakeApi(installation=(404, {"message": "Not Found"})))
        self.assertIn("HTTP 404", str(ctx.exception))

    def test_refuses_an_installation_response_without_an_integer_id(self):
        for payload in ({}, {"id": "42"}, {"id": True}, {"id": None}):
            with self.assertRaises(app_token.TokenError, msg=repr(payload)):
                _mint(FakeApi(installation=(200, payload)))

    def test_refuses_an_installation_body_that_is_not_an_object(self):
        with self.assertRaises(app_token.TokenError):
            _mint(FakeApi(installation=(200, None)))

    def test_refuses_an_expiry_beyond_an_hour(self):
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(FakeApi(minted=_minted_with(expires_at=_iso(NOW + 86400))))
        self.assertIn("short-lived", str(ctx.exception))

    def test_refuses_a_token_already_expired(self):
        with self.assertRaises(app_token.TokenError):
            _mint(FakeApi(minted=_minted_with(expires_at=_iso(NOW - 5))))

    def test_refuses_an_unreadable_expiry(self):
        for value in (None, "tomorrow", 12):
            with self.assertRaises(app_token.TokenError, msg=repr(value)):
                _mint(FakeApi(minted=_minted_with(expires_at=value)))

    def test_refuses_an_empty_app_id(self):
        for app_id in ("", "  ", None):
            with self.assertRaises(app_token.TokenError, msg=repr(app_id)):
                _mint(app_id=app_id)

    def test_refuses_an_empty_private_key_without_calling_the_api(self):
        api = FakeApi()
        for pem in ("", "   \n", None):
            with self.assertRaises(app_token.TokenError, msg=repr(pem)):
                _mint(api, pem=pem)
        self.assertEqual(api.calls, [])

    def test_refuses_a_missing_organisation(self):
        with self.assertRaises(app_token.TokenError):
            _mint(org="")

    def test_a_failure_message_never_carries_the_key_or_token(self):
        api = FakeApi(minted=_minted_with(
            permissions=dict(app_token.REQUIRED_PERMISSIONS, members="write")))
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(api)
        message = str(ctx.exception)
        self.assertNotIn("SECRETKEYMATERIAL", message)
        self.assertNotIn("ghs_FAKETOKEN", message)

    def test_a_long_github_message_is_truncated(self):
        api = FakeApi(minted=(500, {"message": "x" * 1000}))
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(api)
        self.assertLess(len(str(ctx.exception)), 500)

    def test_a_non_string_github_message_is_not_echoed(self):
        api = FakeApi(minted=(500, {"message": {"nested": "ghs_LEAK"}}))
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(api)
        self.assertNotIn("ghs_LEAK", str(ctx.exception))

    def test_a_transport_failure_propagates_as_a_refusal(self):
        def broken(method, url, headers, body=None):
            raise app_token.TokenError("could not reach the GitHub API")

        with self.assertRaises(app_token.TokenError):
            _mint(broken)


class JwtAndSignerTests(unittest.TestCase):
    def test_the_jwt_has_three_unpadded_segments_and_the_right_claims(self):
        jwt = app_token.build_jwt(123, _fake_sign, NOW)
        header, claims, signature = jwt.split(".")
        for segment in (header, claims, signature):
            self.assertNotIn("=", segment)

        def decode(segment):
            return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))

        self.assertEqual(decode(header), {"alg": "RS256", "typ": "JWT"})
        parsed = decode(claims)
        self.assertEqual(parsed["iss"], "123")
        self.assertEqual(parsed["iat"], NOW - app_token.JWT_BACKDATE_SECONDS)
        self.assertLessEqual(parsed["exp"] - parsed["iat"], 600)

    def test_the_signer_passes_the_data_on_stdin_never_in_argv(self):
        seen = {}

        def runner(argv, input, stdout, stderr):
            seen["argv"], seen["input"] = argv, input
            seen["mode"] = os.stat(argv[-1]).st_mode & 0o777
            seen["path"] = argv[-1]
            return MagicMock(returncode=0, stdout=b"sig")

        sign = app_token.openssl_signer(PEM, run=runner)
        self.assertEqual(sign(b"payload"), b"sig")
        self.assertEqual(seen["input"], b"payload")
        self.assertNotIn(b"payload", b" ".join(a.encode() for a in seen["argv"]))
        self.assertEqual(seen["mode"], 0o600)
        self.assertFalse(os.path.exists(seen["path"]), "key file left behind")

    def test_the_key_file_is_removed_when_signing_fails(self):
        seen = {}

        def runner(argv, input, stdout, stderr):
            seen["path"] = argv[-1]
            return MagicMock(returncode=1, stdout=b"", stderr=b"SECRETKEYMATERIAL")

        with self.assertRaises(app_token.TokenError) as ctx:
            app_token.openssl_signer(PEM, run=runner)(b"x")
        self.assertFalse(os.path.exists(seen["path"]))
        self.assertNotIn("SECRETKEYMATERIAL", str(ctx.exception))

    def test_an_empty_signature_is_refused(self):
        runner = lambda argv, input, stdout, stderr: MagicMock(returncode=0, stdout=b"")
        with self.assertRaises(app_token.TokenError):
            app_token.openssl_signer(PEM, run=runner)(b"x")

    def test_a_missing_openssl_is_refused(self):
        def runner(argv, input, stdout, stderr):
            raise OSError("no such file")

        with self.assertRaises(app_token.TokenError):
            app_token.openssl_signer(PEM, run=runner)(b"x")

    @unittest.skipUnless(shutil.which("openssl"), "openssl is not installed")
    def test_a_real_signature_verifies_against_the_public_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            key = os.path.join(tmp, "k.pem")
            pub = os.path.join(tmp, "p.pem")
            subprocess.run(["openssl", "genrsa", "-out", key, "2048"],
                           check=True, capture_output=True)
            subprocess.run(["openssl", "rsa", "-in", key, "-pubout", "-out", pub],
                           check=True, capture_output=True)
            with open(key, encoding="utf-8") as handle:
                pem = handle.read()
            jwt = app_token.build_jwt(7, app_token.openssl_signer(pem), NOW)
            header, claims, signature = jwt.split(".")
            sig_path = os.path.join(tmp, "s.bin")
            with open(sig_path, "wb") as handle:
                handle.write(base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)))
            verdict = subprocess.run(
                ["openssl", "dgst", "-sha256", "-verify", pub, "-signature", sig_path],
                input=("%s.%s" % (header, claims)).encode(), capture_output=True)
            self.assertEqual(verdict.returncode, 0, verdict.stderr)


class HttpRequestTests(unittest.TestCase):
    def _response(self, status, body):
        response = MagicMock()
        response.status = status
        response.read.return_value = body
        response.__enter__.return_value = response
        return response

    def test_parses_a_json_body(self):
        with patch("urllib.request.urlopen", return_value=self._response(200, b'{"a": 1}')):
            self.assertEqual(app_token.http_request("GET", "https://x", {}), (200, {"a": 1}))

    def test_sends_the_body_as_json(self):
        with patch("urllib.request.urlopen",
                   return_value=self._response(201, b"{}")) as opener:
            app_token.http_request("POST", "https://x", {}, {"k": "v"})
        self.assertEqual(opener.call_args[0][0].data, b'{"k": "v"}')

    def test_an_empty_body_is_none(self):
        with patch("urllib.request.urlopen", return_value=self._response(204, b"")):
            self.assertEqual(app_token.http_request("DELETE", "https://x", {}), (204, None))

    def test_an_unparseable_body_is_none(self):
        with patch("urllib.request.urlopen", return_value=self._response(502, b"<html>")):
            self.assertEqual(app_token.http_request("GET", "https://x", {}), (502, None))

    def test_a_non_2xx_answer_is_returned_not_raised(self):
        err = urllib.error.HTTPError("https://x", 403, "no", {}, io.BytesIO(b'{"message": "no"}'))
        with patch("urllib.request.urlopen", side_effect=err):
            self.assertEqual(app_token.http_request("GET", "https://x", {}),
                             (403, {"message": "no"}))

    def test_a_network_failure_is_a_refusal(self):
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
            with self.assertRaises(app_token.TokenError):
                app_token.http_request("GET", "https://x", {})


class RunMintTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.output = os.path.join(self.tmp, "github_output")
        self.env = {
            "GITHUB_OUTPUT": self.output,
            "GITHUB_REPOSITORY_OWNER": ORG,
            app_token.APP_ID_ENV: "123",
            app_token.PRIVATE_KEY_ENV: PEM,
        }

    def _run(self, env=None, api=None):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(app_token.time, "time", return_value=NOW):
            code = app_token.run_mint(
                self.env if env is None else env, out, err,
                http=api or FakeApi(), sign=_fake_sign)
        return code, out.getvalue(), err.getvalue()

    def test_success_masks_then_writes_the_output(self):
        code, out, err = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertTrue(out.startswith("::add-mask::ghs_FAKETOKEN"))
        with open(self.output, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "token=ghs_FAKETOKEN\n")

    def test_the_token_is_masked_before_any_other_output(self):
        _, out, _ = self._run()
        self.assertEqual(out.index("::add-mask::"), 0)

    def test_failure_writes_no_output_and_names_no_fallback(self):
        bad = FakeApi(minted=(422, {"message": "nope"}))
        code, out, err = self._run(api=bad)
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(self.output))
        self.assertNotIn("ghs_", out + err)
        self.assertIn("no fallback credential", err)
        self.assertTrue(err.startswith("::error::"))

    def test_a_wide_grant_exits_one_and_writes_nothing(self):
        wide = FakeApi(minted=_minted_with(
            permissions=dict(app_token.REQUIRED_PERMISSIONS, members="write")))
        code, _, err = self._run(api=wide)
        self.assertEqual(code, 1)
        self.assertIn("extra permission(s)", err)
        self.assertFalse(os.path.exists(self.output))

    def test_a_missing_key_exits_one(self):
        env = dict(self.env)
        del env[app_token.PRIVATE_KEY_ENV]
        code, _, err = self._run(env=env)
        self.assertEqual(code, 1)
        self.assertIn(app_token.PRIVATE_KEY_ENV, err)

    def test_a_missing_app_id_exits_one(self):
        env = dict(self.env)
        del env[app_token.APP_ID_ENV]
        self.assertEqual(self._run(env=env)[0], 1)

    def test_a_missing_output_file_variable_exits_one_without_minting(self):
        env = dict(self.env)
        del env["GITHUB_OUTPUT"]
        api = FakeApi()
        code, _, err = self._run(env=env, api=api)
        self.assertEqual(code, 1)
        self.assertIn("GITHUB_OUTPUT", err)
        self.assertEqual(api.calls, [])

    def test_a_missing_organisation_exits_one(self):
        env = dict(self.env)
        del env["GITHUB_REPOSITORY_OWNER"]
        self.assertEqual(self._run(env=env)[0], 1)


class RunRevokeTests(unittest.TestCase):
    def test_no_token_is_a_quiet_success(self):
        calls = []
        out, err = io.StringIO(), io.StringIO()
        code = app_token.run_revoke({"GH_TOKEN": ""}, out, err,
                                    http=lambda *a, **k: calls.append(a))
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])
        self.assertIn("nothing to revoke", out.getvalue())

    def test_unset_token_is_a_quiet_success(self):
        out, err = io.StringIO(), io.StringIO()
        self.assertEqual(app_token.run_revoke({}, out, err, http=lambda *a, **k: None), 0)

    def test_revokes_with_the_token_itself(self):
        calls = []

        def http(method, url, headers, body=None):
            calls.append((method, url, headers["Authorization"]))
            return 204, None

        out, err = io.StringIO(), io.StringIO()
        code = app_token.run_revoke({"GH_TOKEN": "ghs_T"}, out, err, http=http)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [("DELETE", app_token.API_ROOT + "/installation/token",
                                  "Bearer ghs_T")])
        self.assertNotIn("ghs_T", out.getvalue() + err.getvalue())

    def test_a_failed_revoke_warns_and_still_succeeds(self):
        out, err = io.StringIO(), io.StringIO()
        code = app_token.run_revoke(
            {"GH_TOKEN": "ghs_T"}, out, err, http=lambda *a, **k: (401, None))
        self.assertEqual(code, 0)
        self.assertTrue(err.getvalue().startswith("::warning::"))

    def test_a_transport_failure_on_revoke_warns_and_still_succeeds(self):
        def http(*a, **k):
            raise app_token.TokenError("down")

        out, err = io.StringIO(), io.StringIO()
        self.assertEqual(app_token.run_revoke({"GH_TOKEN": "ghs_T"}, out, err, http=http), 0)
        self.assertIn("::warning::", err.getvalue())

    def test_revoke_token_returns_false_for_a_blank_token(self):
        self.assertFalse(app_token.revoke_token("  ", http=lambda *a, **k: (204, None)))
        self.assertFalse(app_token.revoke_token(None))


class MainTests(unittest.TestCase):
    def test_main_dispatches_mint_and_fails_closed_on_an_empty_environment(self):
        out, err = io.StringIO(), io.StringIO()
        code = app_token.main(["mint"], environ={}, out=out, err=err)
        self.assertEqual(code, 1)
        self.assertIn("::error::", err.getvalue())

    def test_main_dispatches_revoke(self):
        out, err = io.StringIO(), io.StringIO()
        self.assertEqual(app_token.main(["revoke"], environ={}, out=out, err=err), 0)

    def test_main_rejects_an_unknown_command(self):
        with patch("sys.stderr", io.StringIO()):
            with self.assertRaises(SystemExit):
                app_token.main(["frobnicate"], environ={})

    def test_main_reads_the_process_environment_by_default(self):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(app_token.main(["revoke"], out=out, err=err), 0)

    def test_main_defaults_to_the_process_streams(self):
        with patch("sys.stdout", io.StringIO()) as out, patch("sys.stderr", io.StringIO()):
            self.assertEqual(app_token.main(["revoke"], environ={}), 0)
        self.assertIn("nothing to revoke", out.getvalue())


def _installation(**overrides):
    have = dict(app_token.REQUIRED_PERMISSIONS)
    have.update(overrides)
    return 200, {"id": 42, "permissions": have}


class InstallationDiffTests(unittest.TestCase):
    def test_an_exact_installation_has_no_shortfall(self):
        self.assertEqual(
            app_token.permission_shortfalls(dict(app_token.REQUIRED_PERMISSIONS)), [])

    def test_a_missing_permission_is_named_with_none_to_need(self):
        have = dict(app_token.REQUIRED_PERMISSIONS)
        del have["workflows"]
        self.assertEqual(app_token.permission_shortfalls(have),
                         ["workflows: none -> write"])

    def test_an_under_levelled_permission_is_named(self):
        have = dict(app_token.REQUIRED_PERMISSIONS, secrets="read")
        self.assertEqual(app_token.permission_shortfalls(have),
                         ["secrets: read -> write"])

    def test_a_broad_installation_has_no_shortfall(self):
        have = dict(app_token.REQUIRED_PERMISSIONS, members="write",
                    issues="admin", contents="admin", metadata="write")
        self.assertEqual(app_token.permission_shortfalls(have), [])

    def test_a_non_mapping_is_unknown_not_a_shortfall(self):
        for value in (None, [], "write"):
            self.assertIsNone(app_token.permission_shortfalls(value))

    def test_a_malformed_level_counts_as_none(self):
        have = dict(app_token.REQUIRED_PERMISSIONS, secrets=["write"], variables="")
        self.assertEqual(app_token.permission_shortfalls(have),
                         ["secrets: none -> write", "variables: none -> write"])

    def test_every_shortfall_is_listed_in_name_order(self):
        self.assertEqual(
            app_token.permission_shortfalls({"metadata": "read"}),
            ["administration: none -> write", "contents: none -> write",
             "environments: none -> write", "pull_requests: none -> write",
             "secrets: none -> write", "variables: none -> write",
             "workflows: none -> write"])


class PreMintDiagnosisTests(unittest.TestCase):
    def test_a_missing_permission_stops_before_any_mint_call(self):
        have = dict(app_token.REQUIRED_PERMISSIONS)
        del have["workflows"]
        api = FakeApi(installation=(200, {"id": 42, "permissions": have}))
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(api)
        self.assertIn("workflows: none -> write", str(ctx.exception))
        self.assertEqual([c[0] for c in api.calls], ["GET"])

    def test_an_under_levelled_permission_stops_before_any_mint_call(self):
        api = FakeApi(installation=_installation(environments="read"))
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(api)
        self.assertIn("environments: read -> write", str(ctx.exception))
        self.assertEqual(len(api.calls), 1)

    def test_a_broad_installation_still_mints_requesting_exactly_the_eight(self):
        api = FakeApi(installation=_installation(members="write", issues="admin"))
        self.assertEqual(_mint(api), "ghs_FAKETOKEN")
        self.assertEqual(api.calls[-1][3],
                         {"permissions": app_token.REQUIRED_PERMISSIONS})

    def test_an_exact_installation_mints(self):
        self.assertEqual(_mint(FakeApi(installation=_installation())), "ghs_FAKETOKEN")

    def test_the_message_carries_names_and_levels_only(self):
        have = dict(app_token.REQUIRED_PERMISSIONS)
        del have["secrets"]
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(FakeApi(installation=(200, {"id": 42, "permissions": have})))
        message = str(ctx.exception)
        self.assertNotIn("SECRETKEYMATERIAL", message)
        self.assertNotIn("ghs_", message)

    def test_a_422_with_an_exact_installation_says_the_cause_is_not_a_missing_permission(self):
        api = FakeApi(installation=_installation(),
                      minted=(422, {"message": "not granted"}))
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(api)
        self.assertIn("HTTP 422", str(ctx.exception))
        self.assertIn("not a missing one", str(ctx.exception))

    def test_a_422_with_no_installation_permissions_says_nothing_was_comparable(self):
        api = FakeApi(minted=(422, {"message": "not granted"}))
        with self.assertRaises(app_token.TokenError) as ctx:
            _mint(api)
        self.assertIn("no permissions to compare", str(ctx.exception))

    def test_a_422_after_a_changed_installation_names_the_shortfall(self):
        """The installation can change between the read and the mint; the
        refused-mint message re-diffs the installation it read."""
        have = dict(app_token.REQUIRED_PERMISSIONS)
        api = FakeApi(installation=(200, {"id": 42, "permissions": have}),
                      minted=(422, {"message": "x"}))
        with patch.object(app_token, "permission_shortfalls",
                          side_effect=[[], ["secrets: read -> write"]]):
            with self.assertRaises(app_token.TokenError) as ctx:
                _mint(api)
        self.assertIn("secrets: read -> write", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
