# auth.ts

## verifyRequest check order

Checked in this order deliberately:

1. **Format** (timestamp, nonce shape) — free, and a malformed nonce must
   never reach the store below regardless of what else is wrong.
2. **The replay window, including the process-start floor** — stateless, no
   side effect, so checking it before the signature costs nothing and
   rejects a stale or replayed-after-restart request before the expensive
   step. A timestamp older than `processStartSeconds` is refused
   unconditionally: the nonce store is in-memory, so a restart forgets
   every nonce it had claimed, and a request captured seconds before a
   restart can otherwise still be inside an ordinary window (default 60s,
   up to 3600s) once the process comes back.
3. **The signature** — the only step with real cost, and the one that
   actually authenticates the caller.
4. **The nonce claim, last, and only once the signature has verified.**
   Claiming first would let anyone — signed or not — burn a nonce by
   sending its shape with a garbage signature, denying the legitimate
   signer the one nonce they meant to use. This ordering is a control in
   its own right: `auth.test.ts` proves it by sabotage — moving the claim
   above the signature check turns that regression test red.
