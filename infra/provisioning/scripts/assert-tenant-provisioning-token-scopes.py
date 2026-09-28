#!/usr/bin/env python3
"""Check that GH_PAT_TENANT_PROVISIONING can do what this workflow's later
steps need, before any of them has run.

A classic PAT publishes its scopes in `X-OAuth-Scopes`; a fine-grained PAT
publishes nothing equivalent, so an absent header is inapplicable rather
than failed. Never pass the token itself, only a scopes header or value.
See assert-tenant-provisioning-token-scopes.md#module-overview.
"""

from __future__ import annotations

import argparse
import sys

# Derived from what provision-tenant.yml actually does with this token before
# the handover pull request is merged. See assert-tenant-provisioning-token-scopes.md#required_scopes.
REQUIRED_SCOPES = frozenset({"repo", "workflow"})

# The equivalent fine-grained permissions, named in the advisory this script
# prints when it cannot verify them. This list is documentation, not a check:
# nothing here is read back from GitHub, and saying otherwise would be the
# same false assurance this script was rewritten to remove.
FINE_GRAINED_EQUIVALENTS = (
    "Administration (read/write) -- create the tenant repository",
    "Contents (read/write) -- push the handover branch",
    "Workflows (read/write) -- the generated repo carries "
    ".github/workflows/infra-ci.yml",
    "Environments (read/write) -- create the generated repo's production "
    "environment",
    "Secrets and Variables (read/write) -- write the stack passphrase and salt",
    "Pull requests (read/write) -- open the handover pull request",
)


def extract_scopes_header(raw_headers: str) -> str | None:
    """Find the `X-OAuth-Scopes` line in a raw HTTP header dump and return
    its value, or `None` if it never appears — a different fact from an
    empty value. See assert-tenant-provisioning-token-scopes.md#extract_scopes_header."""
    for line in raw_headers.splitlines():
        name, sep, value = line.partition(":")
        if sep and name.strip().lower() == "x-oauth-scopes":
            return value.strip()
    return None


def parse_scopes(header_value: str) -> frozenset[str]:
    """GitHub's `X-OAuth-Scopes` header is a comma-separated list of exact
    scope names, e.g. `"repo, workflow, read:org"`. Split and strip only --
    never substring-match against the raw string, which would let a scope
    like `workflow_dispatch` stand in for `workflow`."""
    return frozenset(
        scope.strip() for scope in header_value.split(",") if scope.strip()
    )


def check(scopes: frozenset[str]) -> frozenset[str]:
    """Returns the required scopes the token does not carry. Empty means the
    token can do everything this run needs."""
    return REQUIRED_SCOPES - scopes


def decide(
    scopes_header: str | None,
    user_endpoint_status: str | None,
    secret_name: str = "GH_PAT_TENANT_PROVISIONING",
) -> tuple[int, str]:
    """The whole policy, as one pure function over the two facts the workflow
    can establish without handling the token. Returns `(exit_code, message)`.
    See assert-tenant-provisioning-token-scopes.md#decide."""
    if scopes_header is not None:
        # A classic PAT. Present-but-empty lands here too and refuses, which
        # is correct: no scopes is a knowable failure.
        missing = check(parse_scopes(scopes_header))
        if missing:
            return 1, _missing_message(missing, secret_name)
        return 0, ""

    # No header at all, so not a classic PAT. What it is instead turns on
    # what GET /user answered.
    status = (user_endpoint_status or "").strip()

    if not status:
        # An un-updated caller, or a status that could not be read. Refuse
        # exactly as this script did before the fine-grained path existed.
        return 1, _unverifiable_message(secret_name)

    if status == "403":
        return 1, _not_a_pat_message(secret_name)

    if status != "200":
        return 1, _indeterminate_message(status, secret_name)

    return 0, _unverifiable_but_a_pat_warning(secret_name)


def _missing_message(missing: frozenset[str], secret_name: str) -> str:
    return (
        "::error::GH_PAT_TENANT_PROVISIONING is missing the OAuth scope(s) "
        f"{', '.join(sorted(missing))}. Every repository generated from "
        "ghost-platform-tenant-template contains "
        ".github/workflows/infra-ci.yml, so this run cannot open its "
        "handover pull request without `workflow`, and cannot create the "
        "repository, its environment or its secrets without `repo`. Add the "
        f"missing scope(s) to the token behind the {secret_name} secret on "
        "the tenant-provisioning environment (https://github.com/settings/"
        "tokens), then re-dispatch. Refusing before creating anything."
    )


def _not_a_pat_message(secret_name: str) -> str:
    return (
        f"::error::the token behind {secret_name} carries no X-OAuth-Scopes "
        "header and GitHub answered GET /user with 403, which no personal "
        "access token does -- an installation token (the workflow's own "
        "GITHUB_TOKEN is one) is the case this matches. It cannot create a "
        "repository in the organization, and no permission grant changes "
        f"that. Set {secret_name} on the tenant-provisioning environment to "
        "a personal access token, classic or fine-grained. Refusing before "
        "creating anything."
    )


def _indeterminate_message(status: str, secret_name: str) -> str:
    return (
        f"::error::could not determine what kind of token {secret_name} is. "
        "It carries no X-OAuth-Scopes header, so it is not a classic PAT, "
        f"and GET /user answered {status} rather than 200 (a personal "
        "access token) or 403 (an installation token). A 401 means the "
        "token is invalid or revoked; a 429 is a secondary rate limit and a "
        "5xx is GitHub being unavailable -- for those two the token may be "
        "perfectly good and re-dispatching later is the fix, so do not "
        "replace it on the strength of this message alone. Refusing before "
        "creating anything rather than guessing."
    )


def _unverifiable_message(secret_name: str) -> str:
    return (
        f"::error::the token behind {secret_name} carries no X-OAuth-Scopes "
        "header, so it is not a classic PAT, and this check was given no "
        "GET /user status -- so it cannot tell a personal access token from "
        "an installation token. Pass --user-endpoint-status with the status "
        "GitHub returned. Refusing before creating anything rather than "
        "assuming."
    )


def _unverifiable_but_a_pat_warning(secret_name: str) -> str:
    """Deliberately a ::warning:: and not a ::notice::: this run proceeds on
    a credential nothing has verified. Single-line, with %0A for the breaks,
    since a literal newline would drop the rest into plain log text.
    See assert-tenant-provisioning-token-scopes.md#_unverifiable_but_a_pat_warning."""
    permissions = "%0A".join(f"  - {line}" for line in FINE_GRAINED_EQUIVALENTS)
    return (
        f"::warning::{secret_name} publishes no OAuth scopes and reads GET "
        "/user, so it is a personal access token but not a classic one -- a "
        "fine-grained PAT, or a GitHub App user access token. GitHub exposes "
        "no API that reads back such a token's own permissions, so this step "
        "cannot verify it in advance the way it verifies a classic token's "
        "scopes. It is proceeding UNVERIFIED, not verified. If a later step "
        "fails for want of a permission, these are the ones this run "
        f"needs:%0A{permissions}"
    )


def _self_test() -> None:
    # -- scope set logic, unchanged --

    # The passing case: both required scopes present, plus one the run
    # never asked for -- an extra scope is never a reason to refuse.
    assert not check(parse_scopes("repo, workflow, read:org"))

    # Nothing at all -- an empty or unreadable header.
    assert check(parse_scopes("")) == REQUIRED_SCOPES

    # `repo` present, `workflow` absent.
    assert check(parse_scopes("repo")) == {"workflow"}

    # The other half missing instead.
    assert check(parse_scopes("workflow")) == {"repo"}

    # The superstring trap this check exists to refuse: `workflow_dispatch`
    # is a real, narrower OAuth scope (it does not grant pushing a workflow
    # file) and must never satisfy a requirement for `workflow`.
    assert check(parse_scopes("repo, workflow_dispatch")) == {"workflow"}

    # Same trap on the other required scope: `repo:status` grants only
    # commit-status writes, not repository creation or secret management.
    assert check(parse_scopes("repo:status, workflow")) == {"repo"}

    # Whitespace around each comma-separated entry is routine in the header
    # and must not itself cause a false miss.
    assert not check(parse_scopes("  repo ,  workflow  "))

    # -- extraction from a raw header dump --

    # The ordinary shape: a status line, other headers, the one that
    # matters, more headers after it.
    assert (
        extract_scopes_header(
            "HTTP/2 200 \r\n"
            "date: Wed, 03 Sep 2026 12:00:00 GMT\r\n"
            "x-oauth-scopes: repo, workflow\r\n"
            "x-ratelimit-limit: 5000\r\n"
        )
        == "repo, workflow"
    )

    # Case-insensitive on the header name -- GitHub's own docs render it
    # `X-OAuth-Scopes`; `gh`'s HTTP/2 output has been observed lower-cased.
    assert extract_scopes_header("X-OAuth-Scopes: repo, workflow\r\n") == "repo, workflow"

    # Absent entirely is now None, NOT "" -- the distinction the
    # fine-grained path turns on.
    assert extract_scopes_header("HTTP/2 200 \r\ndate: Wed, 03 Sep 2026\r\n") is None
    assert extract_scopes_header("HTTP/2 200 \r\n") is None

    # Present but carrying no value stays "" -- a classic token with no
    # scopes, which is knowably broken rather than unverifiable.
    assert extract_scopes_header("x-oauth-scopes:\r\n") == ""

    # A header value containing its own colon must not confuse the header
    # actually being searched for.
    assert extract_scopes_header("date: Wed, 03 Sep 2026 12:00:00 GMT\r\n") is None

    # -- the policy --

    # Classic PAT with both scopes passes, whatever GET /user said.
    assert decide("repo, workflow", "200")[0] == 0
    assert decide("repo, workflow", None)[0] == 0
    assert decide("repo, workflow", "403")[0] == 0

    # Classic PAT missing one still refuses; GET /user does not rescue it.
    code, message = decide("repo", "200")
    assert code == 1 and "workflow" in message

    # Present-but-empty is a classic token with no scopes: refuse, and do
    # NOT take the unverifiable path.
    code, message = decide("", "200")
    assert code == 1 and "missing the OAuth scope(s)" in message

    # A PAT that is not classic: no header, GET /user is 200. Proceeds,
    # under a warning that says plainly it is unverified.
    code, message = decide(None, "200")
    assert code == 0
    assert message.startswith("::warning::") and "UNVERIFIED" in message
    # The permission list must survive as one line, or the annotation drops it.
    assert "\n" not in message and "%0A" in message

    # Installation token: no header, GET /user forbidden. Still refused.
    code, message = decide(None, "403")
    assert code == 1 and "installation token" in message

    # Anything else is indeterminate, never reported as an installation
    # token: a rate limit must not send an operator to replace a good token.
    for status in ("401", "429", "500", "502"):
        code, message = decide(None, status)
        assert code == 1, status
        assert "could not determine" in message and status in message
        assert "installation token (the workflow" not in message

    # No status at all stays fail-closed.
    code, message = decide(None, None)
    assert code == 1 and "--user-endpoint-status" in message
    code, message = decide(None, "   ")
    assert code == 1 and "--user-endpoint-status" in message

    print("self-test OK")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--scopes-header",
        help=(
            "an already-extracted X-OAuth-Scopes header value. Never the "
            "token itself."
        ),
    )
    parser.add_argument(
        "--headers-file",
        help=(
            "path to a raw HTTP response (status line and headers) from an "
            "authenticated call made with GH_PAT_TENANT_PROVISIONING, e.g. "
            "`gh api ... --include --silent`'s output. The X-OAuth-Scopes "
            "header is extracted from it. Never a file holding the token "
            "itself."
        ),
    )
    parser.add_argument(
        "--user-endpoint-status",
        help=(
            "the HTTP status GitHub returned for an authenticated "
            "`GET /user` with this token. Only consulted when there is no "
            "X-OAuth-Scopes header, to tell a personal access token (200) "
            "from an installation token (403) from an inconclusive answer "
            "(anything else). Omitted, an absent header refuses."
        ),
    )
    parser.add_argument(
        "--secret-name",
        default="GH_PAT_TENANT_PROVISIONING",
        help="name of the secret the failure message points the operator at",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        _self_test()
        return 0

    if args.headers_file is not None:
        with open(args.headers_file, encoding="utf-8") as handle:
            scopes_header = extract_scopes_header(handle.read())
    elif args.scopes_header is not None:
        scopes_header = args.scopes_header
    else:
        parser.error("one of --scopes-header or --headers-file is required unless --self-test")
        return 2  # unreachable; parser.error exits, this satisfies type-checkers

    code, message = decide(scopes_header, args.user_endpoint_status, args.secret_name)
    if code:
        print(message, file=sys.stderr)
    elif message:
        # A pass that still has something to say: the unverified-PAT warning.
        print(message)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
