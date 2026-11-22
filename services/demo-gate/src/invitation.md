# invitation.ts

## The token

The emailed arrival link carries one token. The portal signs it with an Ed25519
key that never leaves the control estate; the gate holds only the public half.

The envelope is the one the Ghost image's SSO adapter verifies
(`adapters/sso/README.md`, "Token"): `base64url(JSON claims) "."
base64url(Ed25519 signature over the first segment, as sent)`. One token opens
both doors, in order. The gate exchanges it for a session, then the adapter
turns it into an admin session for the one account it is pinned to.

## What the gate adds

A `host` claim, which must equal the request's own host. A token minted for one
demo's hostname is refused at every other. A hostname is allocated once and
never reissued, so `host` names exactly one tenancy.

Lifetime is capped at 900 seconds, the adapter's own cap, and a token issued
more than 60 seconds ahead of the gate's clock is refused.

## What it does not do

It does not know whether a token was used: that is the ledger's answer
(`usedTokens.ts`). A verdict of `ok` means "genuine, unexpired, for this host",
never "admit".
