# mollie-test-charge.py

## What it does

Proves the payment account and the API path in Mollie's **test mode**, by
hand, before any platform code depends on them. One run makes four calls:

1. `POST /payments`: one payment of 1.00 EUR with a placeholder description.
   It is created, not paid: the status is `open` until a customer completes a
   checkout, and the script never prints or follows the checkout link.
2. `POST /customers`: one customer with placeholder name and address.
3. `POST /customers/{id}/mandates`: a SEPA direct-debit mandate for that
   customer, using an example IBAN shape from Mollie's reference. Card mandates
   cannot be created through the API; they need a customer at a checkout.
4. `POST /customers/{id}/subscriptions`: a recurring schedule of 1.00 EUR a
   month, `times: 1`, so it is bounded.

It prints one line per object (`id`, `status`, `mode`) and a final `ok:` line.

## Refusals

- The key is read from `MOLLIE_API_KEY_TEST` only. Empty, unset, not of the
  form `test_` plus alphanumerics, or containing a control character: exit 2,
  **before any network call**, and the value is never echoed. A live key can
  therefore not be used.
- Every response must say `mode` is `test` and carry an id of the expected
  kind. Anything else: exit 1, and no later call is made.
- The key, the `Authorization` header and the response bodies are never
  printed. A failure prints the step, the HTTP status and Mollie's `title`
  only, with the key redacted if it was echoed.
- No `testmode` parameter is sent: a test key selects test mode itself.

Exit codes: 0 all steps succeeded, 1 a step failed, 2 key refused.

## Currency

EUR for both the payment and the schedule: SEPA direct debit is euro only, and
it is the only mandate type the API can create without a checkout. No price in
this repository fixes a currency. A pound-priced card schedule needs a first
payment completed in a checkout and is not part of this proof.

## Where it runs

`.github/workflows/mollie-test-charge.yml`, by `workflow_dispatch` only, on
`main` only. The job declares `environment: production`, so it waits for that
environment's required reviewer before any step. The key is the environment
secret `MOLLIE_API_KEY_TEST`; keep it off the repository level, where a branch
run could read it. The workflow runs this script's unit tests first, with no
secret in scope. If the secret has not been added, the script refuses with
exit 2.

## Tests

`scripts/test_mollie_test_charge.py` uses a recording fake of the HTTP layer and
makes the real one raise, so no test can reach Mollie. It covers every refused
key shape with a check that no call was made, the call order and bodies, a
live-mode response, an HTTP error, a non-JSON body, a transport fault that
carries the key, and the workflow's shape (trigger, environment, permissions,
sha-pinned actions, the key bound to one step).

Sabotage: removing the key-shape check turns 11 tests red; removing the mode
check turns 2 red. `repo-tooling-ci.yml` runs the suite on every push and pull
request.
