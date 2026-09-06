#!/usr/bin/env python3
"""Check that GH_PAT_TENANT_PROVISIONING carries every OAuth scope this
workflow's later steps need, before any of them has run.

A token missing a scope this run needs fails on whichever later step first
calls for it -- by which point the run may already have created a public
repository, minted and escrowed a passphrase, initialised a Pulumi stack and
published an encryption salt to a repository secret. All of that is knowable
in advance from one authenticated API response -- GitHub returns a classic
token's scopes in its `X-OAuth-Scopes` response header -- so this script
exists to read that header and refuse before anything is created, rather
than after.

This holds the extraction and the set logic together, exactly because the
extraction is the part worth distrusting: a raw HTTP header dump is
attacker-adjacent input in miniature, and a shell one-liner reaching into it
(`grep | sed | tr`) has no test of its own and can abort a `pipefail` step
before ever reaching the refusal it was meant to produce. Handing the whole
dump to this script keeps that reach testable offline instead of only by
dispatching the workflow for real.

    assert-tenant-provisioning-token-scopes.py --self-test
    assert-tenant-provisioning-token-scopes.py --scopes-header "repo, workflow"
    assert-tenant-provisioning-token-scopes.py --headers-file /tmp/response.txt

`--headers-file` takes the raw response (status line and headers, e.g. from
`gh api ... --include --silent`) and extracts the one header this needs;
`--scopes-header` takes an already-extracted value directly. A header that
is absent, or present but empty, both parse to no scopes at all and refuse
exactly like a token with none -- there is no path through this script that
aborts instead of refusing.

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


def extract_scopes_header(raw_headers: str) -> str:
    """Find the `X-OAuth-Scopes` line in a raw HTTP header dump and return
    its value. Case-insensitive on the header name, matched line by line
    rather than by a single combined pattern so a status line or any other
    header (each of which may itself contain a colon, e.g. `date:`) can
    never be mistaken for it.

    Returns the empty string -- meaning no scopes at all -- when the header
    never appears, rather than raising: a fine-grained PAT or the default
    `GITHUB_TOKEN` carries no such header, and that is itself a fact this
    check must refuse on, not a condition to abort over."""
    for line in raw_headers.splitlines():
        name, sep, value = line.partition(":")
        if sep and name.strip().lower() == "x-oauth-scopes":
            return value.strip()
    return ""


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


def _self_test() -> None:
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

    # Absent entirely -- a fine-grained PAT or GITHUB_TOKEN. Empty, not a
    # raised exception; parse_scopes/check on the result then refuse both
    # required scopes exactly as an empty header value would.
    assert extract_scopes_header("HTTP/2 200 \r\ndate: Wed, 03 Sep 2026\r\n") == ""
    assert check(parse_scopes(extract_scopes_header("HTTP/2 200 \r\n"))) == REQUIRED_SCOPES

    # Present but carrying no value.
    assert extract_scopes_header("x-oauth-scopes:\r\n") == ""

    # A header value containing its own colon must not confuse the header
    # actually being searched for.
    assert extract_scopes_header("date: Wed, 03 Sep 2026 12:00:00 GMT\r\n") == ""

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

    missing = check(parse_scopes(scopes_header))
    if missing:
        print(_missing_message(missing, args.secret_name), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
