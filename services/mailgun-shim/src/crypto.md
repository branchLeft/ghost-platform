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
