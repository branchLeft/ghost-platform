# mint-tenant-passphrase.py

## Module overview

Prints exactly one high-entropy value to stdout and nothing else, so the
caller captures it with plain command substitution — no prefix, no trailing
explanation, nothing a stray print could mix into the value that then gets
written into a GitHub Actions secret and an `encryptionsalt`-bearing config
file.

Uses `secrets.token_urlsafe`, the CSPRNG-backed generator, never `random`:
`random` is a Mersenne Twister, seedable and predictable from enough output,
and a passphrase is exactly the value that must not be.
