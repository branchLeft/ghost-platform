# tenant_provisioning_app_token.py

## Module overview

`provision-tenant.yml` creates a repository in the organisation, sets its
secrets and variables and environment, and pushes the first branch to it. The
workflow's own token cannot do any of that, so it used to read a personal
access token belonging to a person. That is automation on a person's own
account, and the estate's compliant route is a GitHub App.

This module is that route. It signs a short-lived JWT with the App's private
key, finds the App's installation on the organisation, and asks for an
installation token holding exactly the permissions below. The token lasts an
hour, is handed to later steps as a masked step output, and is revoked by the
workflow's last step.

It fails closed. A missing id or key, an unreachable API, a refused mint, a
response without a token, a grant that differs from the named permissions in
either direction, or an expiry beyond an hour all stop the run before anything
is created. There is no fallback credential, and the workflow's tests refuse
any reintroduction of one.

## required_permissions

Exactly these, and no others, because each is something the workflow does:

- `administration: write` creates the tenant repository from the template, and
  reads the `tenant-provisioning` environment's protection rules.
- `contents: write` reads the template and pushes the handover branch.
- `workflows: write` pushes the generated repository's `infra-ci.yml`.
- `environments: write` creates the generated repository's `production`
  environment with its required reviewer.
- `secrets: write` writes the stack passphrase, the encryption salt and the
  state credentials, and reads which secrets exist.
- `variables: write` writes the backend URL and the app host address.
- `pull_requests: write` opens the handover pull request.
- `metadata: read` is granted to every installation token.

The check compares the grant GitHub returns, not the request, so an extra
permission is refused as firmly as a missing one.

## Residual reach

The repository does not exist when the token is minted, so it cannot be named
in the request. The installation therefore has to cover all repositories in the
organisation, and the token can reach them within the permissions above. The
permissions, the hour and the revocation are the bounds; the repository list is
not one.

## Diagnosing a refused mint

GitHub answers a mint for permissions the installation does not hold with an
unhelpful 422 that names none of them. The installation lookup already returns
the installation's own permissions, so the module diffs them against the eight
before minting and stops with each shortfall named as `name: have -> need`
(names and levels only). A broader installation is fine: the mint requests
exactly the eight, so GitHub narrows the token. The same diff is attached to
any refused mint, saying when the installation grants everything named and the
cause is elsewhere.
