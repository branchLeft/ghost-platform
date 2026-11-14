# crypto.ts

## hashApiKey

scrypt with a per-tenant random salt, not a bare fast hash — CodeQL
(js/insufficient-password-hash) correctly flags a fast digest here even
though an API key's entropy comes from randomness rather than a human
picking it: the lookup-by-domain-then-verify shape below means nothing
about this being a "password field" changes just because we're confident
the input is high-entropy, and a proper KDF costs nothing at this call
volume.

Stays on the synchronous form: registration is an operator-driven,
one-off CLI action (cli.ts), never on a request path this service
answers under load, so there is nothing here for a blocked event loop to
cost.

## keyMatchesSync

The synchronous twin of `verifyApiKey`, for the one caller that is not on a
request path: registration, which has to find out whether a key is already
bound to another credential (store.md#registration-refusals). Salts are per
row, so there is no digest to look a key up by; the key is hashed once under
each other row's salt and compared in constant time. That costs one scrypt per
registered credential, an operator-run CLI action measured in seconds even for
a demo host's slot count, so it does not need to be asynchronous. A corrupted
stored record is "no match", the same fail-closed reading `verifyApiKey` gives.
