#!/usr/bin/env python3
"""Check that GH_PAT_TENANT_PROVISIONING can do what this workflow's later
steps need, before any of them has run.

A token that cannot finish fails on whichever later step first calls for the
thing it lacks -- by which point the run may already have created a public
repository, minted and escrowed a passphrase, initialised a Pulumi stack and
published an encryption salt to a repository secret. Refusing before anything
is created is the whole point of this script.

How much can be known in advance depends on what kind of token it is, and the
two kinds differ in a way that is not a detail:

  - A **classic** PAT publishes its own scopes in the `X-OAuth-Scopes`
    response header on any authenticated call. Every scope this run needs is
    therefore knowable from one response, and a token missing one is refused
    here.

  - A **fine-grained** PAT publishes nothing equivalent. GitHub exposes no
    API that reads back a fine-grained token's own permissions, so there is
    no request this script could make that would tell it whether the token
    can create a repository. The check is not failing in this case -- it is
    *inapplicable*.

Treating "inapplicable" as "failed" is what this script did until it refused
a fine-grained token that had already provisioned a tenant successfully. That
is a false refusal with a real cost: the only way to satisfy the check was to
replace a narrowly-permissioned fine-grained token with a classic `repo` one,
which grants full control of every repository the account can reach. A guard
that can only be satisfied by widening a credential is pushing the wrong way.

So an absent header is no longer refused on its own. What must still be
refused is a token that is not a PAT at all -- the workflow's own
`GITHUB_TOKEN` is an installation token, carries no `X-OAuth-Scopes` header
either, and cannot create a repository in the organization. That case is
distinguished without ever handling the token: an installation token is
refused `GET /user` (403), while a PAT of either kind reads it (200). The
workflow makes that call and passes the outcome in.

    assert-tenant-provisioning-token-scopes.py --self-test
    assert-tenant-provisioning-token-scopes.py --scopes-header "repo, workflow"
    assert-tenant-provisioning-token-scopes.py --headers-file /tmp/response.txt \
        --token-reads-user-endpoint yes

`--headers-file` takes the raw response (status line and headers, e.g. from
`gh api ... --include --silent`) and extracts the one header this needs;
`--scopes-header` takes an already-extracted value directly.

A header that is **present but empty** is still a refusal: that is a classic
token carrying no scopes, which is a knowable failure rather than an
unknowable one. Only a header that is **absent entirely** takes the
fine-grained path, and only when `--token-reads-user-endpoint yes` says the
token is a PAT. Without that flag an absent header refuses exactly as before,
so every caller that has not been updated stays fail-closed.

The header value is parsed into exact, comma-separated tokens and compared
by set membership -- never by substring search. `workflow_dispatch` and
`repo:status` are both real, narrower OAuth scopes that contain a required
scope's name as a prefix; a substring match would accept either in place of
the scope it actually needs, which is a silent way for this whole check to
be vacuous.

Never pass the token itself to this script, in any argument or file --
only a scopes header or value, which names no secret.
"""

from __future__ import annotations

import argparse
import sys

# Derived from what provision-tenant.yml actually does with this token before
# the handover pull request is merged, not from whichever one scope a given
# run happened to be missing:
#
#   - `repo`: `gh repo create --template`, reading and writing the
#     tenant-provisioning environment's own protection rules and secrets,
#     creating the generated repo's `production` environment, `gh secret
#     set` / `gh variable set` against it, and `gh pr create`. All of these
#     are repository- and organization-content operations that classic
#     OAuth scopes gate behind `repo` (`public_repo` covers only public
#     repositories, and a tenant repo may be private).
#   - `workflow`: pushing a commit that adds or updates a
#     `.github/workflows/*.yml` file. Every repository generated from
#     ghost-platform-tenant-template carries `.github/workflows/infra-ci.yml`,
#     so the handover push always touches one.
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
    its value. Case-insensitive on the header name, matched line by line
    rather than by a single combined pattern so a status line or any other
    header (each of which may itself contain a colon, e.g. `date:`) can
    never be mistaken for it.

    Returns `None` when the header never appears, which is a different fact
    from an empty value and is now treated differently: absent means the
    token is not a classic PAT, while present-but-empty means a classic PAT
    holding no scopes at all. Collapsing the two -- as this returned `""`
    for both until a fine-grained token was refused for it -- makes the
    unknowable case indistinguishable from the knowably-broken one."""
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
    reads_user_endpoint: bool | None,
    secret_name: str = "GH_PAT_TENANT_PROVISIONING",
) -> tuple[int, str]:
    """The whole policy, as one pure function over the two facts the workflow
    can establish without handling the token: what the `X-OAuth-Scopes`
    header said (or that there wasn't one), and whether `GET /user`
    succeeded.

    Returns `(exit_code, message)`. Exit 0 passes; the message may still
    carry a notice worth printing."""
    if scopes_header is not None:
        # A classic PAT. Present-but-empty lands here too and refuses, which
        # is correct: no scopes is a knowable failure.
        missing = check(parse_scopes(scopes_header))
        if missing:
            return 1, _missing_message(missing, secret_name)
        return 0, "token scopes OK: classic PAT carrying repo and workflow"

    # No header at all. Not a classic PAT.
    if reads_user_endpoint is None:
        # An un-updated caller. Refuse exactly as this script did before the
        # fine-grained path existed, rather than passing something it has
        # established nothing about.
        return 1, _unverifiable_message(secret_name)

    if not reads_user_endpoint:
        # GET /user was refused: an installation token (the workflow's own
        # GITHUB_TOKEN is one). It cannot create a repository in the
        # organization, and no permission grant changes that.
        return 1, _not_a_pat_message(secret_name)

    return 0, _fine_grained_notice(secret_name)


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
        "header and is refused `GET /user`, which makes it an installation "
        "token rather than a personal access token -- the workflow's own "
        "GITHUB_TOKEN is one. It cannot create a repository in the "
        "organization, and no permission grant changes that. Set "
        f"{secret_name} on the tenant-provisioning environment to a personal "
        "access token, classic or fine-grained. Refusing before creating "
        "anything."
    )


def _unverifiable_message(secret_name: str) -> str:
    return (
        f"::error::the token behind {secret_name} carries no X-OAuth-Scopes "
        "header, so it is not a classic PAT, and this check was not told "
        "whether it can read GET /user -- so it cannot tell a fine-grained "
        "PAT from an installation token. Pass "
        "--token-reads-user-endpoint yes|no. Refusing before creating "
        "anything rather than assuming."
    )


def _fine_grained_notice(secret_name: str) -> str:
    permissions = "\n".join(f"  - {line}" for line in FINE_GRAINED_EQUIVALENTS)
    return (
        f"::notice::{secret_name} is a fine-grained personal access token. "
        "GitHub publishes no API that reads back a fine-grained token's own "
        "permissions, so this step cannot verify it in advance the way it "
        "verifies a classic token's OAuth scopes -- it is proceeding "
        "unverified, not verified. If this run fails on a later step for "
        "want of a permission, these are the ones it needs:\n"
        f"{permissions}"
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

    # Classic PAT with both scopes passes, whatever the /user answer.
    assert decide("repo, workflow", True)[0] == 0
    assert decide("repo, workflow", None)[0] == 0

    # Classic PAT missing one still refuses, and reading /user does not
    # rescue it -- a classic token's scopes are authoritative.
    code, message = decide("repo", True)
    assert code == 1 and "workflow" in message

    # Present-but-empty is a classic token with no scopes: refuse, and do
    # NOT take the fine-grained path.
    code, message = decide("", True)
    assert code == 1 and "missing the OAuth scope(s)" in message

    # Fine-grained PAT: no header, reads /user. Proceeds, with a notice that
    # says plainly it is unverified.
    code, message = decide(None, True)
    assert code == 0
    assert "::notice::" in message and "unverified" in message

    # Installation token (the workflow's own GITHUB_TOKEN): no header, and
    # /user refused. This is the case that must still be refused.
    code, message = decide(None, False)
    assert code == 1 and "installation token" in message

    # An un-updated caller that passes no /user answer stays fail-closed.
    code, message = decide(None, None)
    assert code == 1 and "--token-reads-user-endpoint" in message

    print("self-test OK")


def _parse_tristate(value: str | None) -> bool | None:
    if value is None:
        return None
    normalised = value.strip().lower()
    if normalised in {"yes", "true", "1"}:
        return True
    if normalised in {"no", "false", "0"}:
        return False
    raise ValueError(f"expected yes or no, got {value!r}")


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
        "--token-reads-user-endpoint",
        choices=["yes", "no", "true", "false", "1", "0"],
        help=(
            "whether an authenticated `GET /user` succeeded with this token. "
            "Only consulted when there is no X-OAuth-Scopes header, to tell "
            "a fine-grained PAT (200) from an installation token (403). "
            "Omitted, an absent header refuses."
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

    reads_user = _parse_tristate(args.token_reads_user_endpoint)
    code, message = decide(scopes_header, reads_user, args.secret_name)
    if code:
        print(message, file=sys.stderr)
    elif message.startswith("::notice::"):
        print(message)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
