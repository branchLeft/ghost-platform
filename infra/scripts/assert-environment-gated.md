# assert-environment-gated.py

Fails closed unless a GitHub environment really gates its deploy job. Run by
`.github/workflows/infra-demo-host-ci.yml`: `--self-test` on every PR, and the
real check as the apply job's first step after checkout.

Gated means either of:

- `GET environments/{env}` has a `protection_rules[]` entry with
  `type == "required_reviewers"`; or
- `GET environments/{env}/deployment_protection_rules` has a
  `custom_deployment_protection_rules[]` entry with `enabled == true`,
  `app.id == 5090756` and `app.slug == "branchleft-reviewer"` (both must match).

A custom deployment protection rule is not listed in `protection_rules[]`
(recorded from the live API), so the second endpoint must be read. Either
response being unreadable, or an error body, is not gated.

Recorded shape of the second endpoint:

```json
{"total_count":1,"custom_deployment_protection_rules":[{"id":68095246,"enabled":true,"app":{"id":5090756,"slug":"branchleft-reviewer","integration_url":"https://api.github.com/apps/branchleft-reviewer"}}]}
```

Tests: `--self-test` (pure decision cases) and `test_assert_environment_gated.py`
(runs the CLI as CI does and checks the real exit code).
