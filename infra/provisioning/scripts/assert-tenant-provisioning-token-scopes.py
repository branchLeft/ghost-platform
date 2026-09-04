#!/usr/bin/env python3
"""Check that GH_PAT_TENANT_PROVISIONING carries every OAuth scope this
workflow's later steps need, before any of them has run.

`provision-tenant.yml` failed mid-run when the token turned out to lack
`workflow`: by the point the push was rejected, the run had already created a
public repository, minted and escrowed a passphrase, initialised a Pulumi
stack and published an encryption salt to a repository secret. All of that
is knowable in advance from one authenticated API response -- GitHub returns
the token's scopes in its `X-OAuth-Scopes` response header -- so this script
exists to read that header and refuse before anything is created, rather
than after.

This holds only the set logic, exactly like
assert-tenant-provisioning-scoping.py beside it: the caller's job is to fetch
an authenticated response and hand this script the raw header value, which
keeps the comparison provable offline instead of only by dispatching the
workflow for real.

    assert-tenant-provisioning-token-scopes.py --self-test
    assert-tenant-provisioning-token-scopes.py --scopes-header "repo, workflow"

The header is parsed into exact, comma-separated tokens and compared by set
membership -- never by substring search. `workflow_dispatch` and `repo:status`
are both real, narrower OAuth scopes that contain a required scope's name as
a prefix; a substring match would accept either in place of the scope it
actually needs, which is a silent way for this whole check to be vacuous.

Never pass the token itself to this script, in any argument or file --
only the scopes header value, which names no secret.
"""

from __future__ import annotations

import argparse
import sys

# Derived from what provision-tenant.yml actually does with this token before
# the handover pull request is merged, not from the one scope the 2026-09-02
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
#     so the handover push always touches one -- this is the scope the
#     2026-09-02 run lacked.
REQUIRED_SCOPES = frozenset({"repo", "workflow"})


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

    # The exact 2026-09-02 case: `repo` present, `workflow` absent.
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

    print("self-test OK")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--scopes-header",
        help=(
            "the raw value of the X-OAuth-Scopes response header from an "
            "authenticated GitHub API call made with GH_PAT_TENANT_PROVISIONING. "
            "Never the token itself."
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

    if args.scopes_header is None:
        parser.error("--scopes-header is required unless --self-test")

    missing = check(parse_scopes(args.scopes_header))
    if missing:
        print(_missing_message(missing, args.secret_name), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
