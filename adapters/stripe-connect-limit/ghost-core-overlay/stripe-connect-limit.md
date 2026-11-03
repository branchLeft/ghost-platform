# settings.js (Stripe connect limit)

Documents Ghost's `core/server/models/settings.js` as the image ships it: Ghost's own file with
`stripe-connect-limit.patch` applied at build time (see `README.md`). No copy of the file is committed.

## onValidate

Every settings write goes through the settings model's `onValidate`, whichever route it came from. The
patch adds one check before the validators run:

| Condition | Result |
|---|---|
| The key is `stripe_secret_key`, `stripe_publishable_key`, `stripe_connect_secret_key` or `stripe_connect_publishable_key`, and | `NoPermissionError` carrying the refusal text in its `context` |
| the value is set (not null, not empty), and | |
| `config.get('hostSettings:limits:limitStripeConnect:disabled')` is truthy | |

With the limit unset the check never fires, so one image serves every tenant. Clearing a key stays allowed,
so a slot can still disconnect.

## Why here

Ghost's own `limitStripeConnect` guards one of three write paths, the Connect-token edit. A direct key `PUT`
runs only the key-format check, and the content importer calls the model directly. The model is the one place
all three meet.

## The refusal text

`DEMO_STRIPE_CONNECT_REFUSED` is an ALL_CAPS placeholder in the `messages` object. The owner replaces it with
real text under a separate authorisation: edit the patch, re-derive the pin, nothing else. The image test reads
the text from the patch, so it follows.

## Through the importer

Ghost runs a content import as a background job in a single transaction. A refused row fails the whole import,
which rolls back; the request still answers 200 and the failure is logged and mailed to the owner.
