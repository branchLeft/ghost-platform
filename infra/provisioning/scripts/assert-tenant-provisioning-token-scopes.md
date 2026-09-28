# assert-tenant-provisioning-token-scopes.py

## Module overview

A token that cannot finish fails on whichever later step first calls for the
thing it lacks — by which point the run may already have created a public
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
    can create a repository. The check is not failing in this case — it is
    *inapplicable*.

Treating "inapplicable" as "failed" is what this script did until it refused
a fine-grained token that had already provisioned a tenant successfully. That
is a false refusal with a real cost: the only way to satisfy the check was to
replace a narrowly-permissioned fine-grained token with a classic `repo` one,
which grants full control of every repository the account can reach. A guard
that can only be satisfied by widening a credential is pushing the wrong way.

So an absent header is no longer refused on its own. What must still be
refused is a token that is not a PAT at all — the workflow's own
`GITHUB_TOKEN` is an installation token, carries no `X-OAuth-Scopes` header
either, and cannot create a repository in the organization. That case is
distinguished without ever handling the token: an installation token is
refused `GET /user` (403), while a PAT of either kind reads it (200). The
workflow makes that call and passes the *status* in — not a pass/fail
boolean, so a rate limit or an outage is reported as inconclusive rather
than miscalled an installation token.

Usage:

```text
assert-tenant-provisioning-token-scopes.py --self-test
assert-tenant-provisioning-token-scopes.py --scopes-header "repo, workflow"
assert-tenant-provisioning-token-scopes.py --headers-file /tmp/response.txt \
    --user-endpoint-status 200
```

`--headers-file` takes the raw response (status line and headers, e.g. from
`gh api ... --include --silent`) and extracts the one header this needs;
`--scopes-header` takes an already-extracted value directly.

A header that is **present but empty** is still a refusal: that is a classic
token carrying no scopes, which is a knowable failure rather than an
unknowable one. Only a header that is **absent entirely** takes the
unverifiable path, and only when `--user-endpoint-status 200` says the token
is a PAT at all. Without that status an absent header refuses exactly as
before, so every caller that has not been updated stays fail-closed.

The header value is parsed into exact, comma-separated tokens and compared
by set membership — never by substring search. `workflow_dispatch` and
`repo:status` are both real, narrower OAuth scopes that contain a required
scope's name as a prefix; a substring match would accept either in place of
the scope it actually needs, which is a silent way for this whole check to
be vacuous.

Never pass the token itself to this script, in any argument or file —
only a scopes header or value, which names no secret.

## REQUIRED_SCOPES

Derived from what provision-tenant.yml actually does with this token before
the handover pull request is merged, not from whichever one scope a given
run happened to be missing:

  - `repo`: `gh repo create --template`, reading and writing the
    tenant-provisioning environment's own protection rules and secrets,
    creating the generated repo's `production` environment, `gh secret
    set` / `gh variable set` against it, and `gh pr create`. All of these
    are repository- and organization-content operations that classic
    OAuth scopes gate behind `repo` (`public_repo` covers only public
    repositories, and a tenant repo may be private).
  - `workflow`: pushing a commit that adds or updates a
    `.github/workflows/*.yml` file. Every repository generated from
    ghost-platform-tenant-template carries `.github/workflows/infra-ci.yml`,
    so the handover push always touches one.

## extract_scopes_header

Find the `X-OAuth-Scopes` line in a raw HTTP header dump and return its
value. Case-insensitive on the header name, matched line by line rather
than by a single combined pattern so a status line or any other header
(each of which may itself contain a colon, e.g. `date:`) can never be
mistaken for it.

Returns `None` when the header never appears, which is a different fact
from an empty value and is now treated differently: absent means the
token is not a classic PAT, while present-but-empty means a classic PAT
holding no scopes at all. Collapsing the two — as this returned `""`
for both until a fine-grained token was refused for it — makes the
unknowable case indistinguishable from the knowably-broken one.

## decide

The whole policy, as one pure function over the two facts the workflow
can establish without handling the token: what the `X-OAuth-Scopes`
header said (or that there wasn't one), and what `GET /user` answered.

The second is an explicit HTTP status rather than a success/failure
boolean on purpose. Exit-code truthiness collapses 403 (an installation
token — a real, diagnosable answer) together with 401, a 429 secondary
rate limit, a 5xx and a DNS blip, and then reports all of them as
"installation token". Telling an operator to replace a working
fine-grained PAT because GitHub rate-limited one request is the same
class of harm this script was rewritten to stop causing.

Returns `(exit_code, message)`. Exit 0 passes; the message may still
carry an annotation worth printing.

## _unverifiable_but_a_pat_warning

Deliberately a ::warning:: and not a ::notice::. This run goes on to
create a public repository, mint and escrow a passphrase and publish a
secret, on a credential nothing has verified. This repo's own precedent
for "proceeding with a control absent" is a warning, and a blue notice
on a green step is read past.

Single-line, with %0A for the breaks: workflow commands are
line-oriented, so a literal newline ends the annotation and everything
after it falls out into plain log text. That would drop exactly the
permission list this message exists to carry.
